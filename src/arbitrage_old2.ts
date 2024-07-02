import { request } from 'graphql-request'
import * as UNISWAP from './dex_queries/uniswap';
import * as SUSHISWAP from './dex_queries/sushiswap';

import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge from './graph_library/GraphEdge';
import bellmanFord from './bellman-ford';
import { DEX, MIN_TVL, SLIPPAGE, LENDING_FEE, MINPROFIT } from './constants';

const ALLOWED_TOKENS = [
  '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
  '0xfa68fb4628dff1028cfec22b4162fccd0d45efb6',
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39',
  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  '0xd6df932a45c0f255f85145f286ea0b292b21c90b'
];

async function fetchTokens(first, skip = 0, dex: DEX) {
  let dexEndpoint = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : SUSHISWAP.ENDPOINT;
  let tokensQuery = (dex === DEX.UniswapV3) ? UNISWAP.HIGHEST_VOLUME_TOKENS(first) : SUSHISWAP.HIGHEST_VOLUME_TOKENS(first, skip);
  let mostActiveTokens = await request(dexEndpoint, tokensQuery);

  if (!mostActiveTokens || !mostActiveTokens.tokens) {
    console.error('No se encontraron tokens en la respuesta:', mostActiveTokens);
    return [];
  }

  let top20Tokens = mostActiveTokens.tokens
  .filter(t => ALLOWED_TOKENS.includes(t.id))
  .slice(0, 9);

  console.log(`Tokens:`,  top20Tokens );

  return top20Tokens.map((t) => { return t.id });
}

function classifyEdge(g, startKey, endKey) {
  let startVertex = g.getVertexByKey(startKey);
  let endVertex = g.getVertexByKey(endKey);
  let edge = g.findEdge(startVertex, endVertex);

  if (edge.rawWeight > 1 + SLIPPAGE + LENDING_FEE) {
    return 'buy';
  } else {
    return 'sell';
  }
}

function calculatePathData(g, cycle, initialAmount: number) {
  let cycleWeight = 1.0;
  let finalAmount = initialAmount;

  for (let index = 0; index < cycle.length - 1; index++) {
    let startVertex = g.getVertexByKey(cycle[index]);
    let endVertex = g.getVertexByKey(cycle[index + 1]);
    let edge = g.findEdge(startVertex, endVertex);
    let amount = edge.metadata.amount;

    cycleWeight *= edge.rawWeight * amount * (1 + SLIPPAGE + LENDING_FEE);
    finalAmount *= edge.rawWeight * (1 + SLIPPAGE + LENDING_FEE);
  }

  return { cycleWeight, finalAmount };
}

async function calcArbitrage(g, initialAmount: number = 1) {
  let arbitrageData = [];
  let uniqueCycle = {};

  g.getAllVertices().forEach((vertex) => {
    let result = bellmanFord(g, vertex);
    let cyclePaths = result.cyclePaths;
    for (var cycle of cyclePaths) {
      let cycleString = cycle.join('');
      if (!uniqueCycle[cycleString]) {
        uniqueCycle[cycleString] = true;
        let { cycleWeight, finalAmount } = calculatePathData(g, cycle, initialAmount);
        let cycleType = classifyCycle(g, cycle);
        arbitrageData.push({ cycle, initialAmount, cycleWeight, finalAmount, type: cycleType });
      }
    }
  });
  return arbitrageData;
}

async function fetchUniswapPools(tokenIds) {
  let pools = new Set<string>();
  let tokenIdsSet = new Set(tokenIds);

  for (let id of tokenIds) {
    let whitelistPoolsRaw = await request(UNISWAP.ENDPOINT, UNISWAP.token_whitelist_pools(id));
    let whitelistPools = whitelistPoolsRaw.token.whitelistPools;

    for (let pool of whitelistPools) {
      let otherToken = (pool.token0.id === id) ? pool.token1.id : pool.token0.id;
      if (tokenIdsSet.has(otherToken)) {
        pools.add(pool.id)
      }
    }
  }
  return pools;
}

async function fetchSushiswapPools(tokenIds) {
  let pools = new Set<string>();
  let poolsDataRaw = await request(SUSHISWAP.ENDPOINT, SUSHISWAP.PAIRS(tokenIds));
  let poolsData = poolsDataRaw.pairs;

  for (let pool of poolsData) {
    pools.add(pool.id);
  }
  return pools;
}

async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false) {
  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    if (debug) console.log(dex, pool)
    let DEX_ENDPOINT = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT :
                       (dex === DEX.Sushiswap) ? SUSHISWAP.ENDPOINT : "";
    let DEX_QUERY = (dex === DEX.UniswapV3) ? UNISWAP.fetch_pool(pool) :
                    (dex === DEX.Sushiswap) ? SUSHISWAP.PAIR(pool) : "";

    let poolRequest = await request(DEX_ENDPOINT, DEX_QUERY);
    console.log("poolRequest", poolRequest);

    let poolData = (dex === DEX.UniswapV3) ? poolRequest.pool :
                   (dex === DEX.Sushiswap) ? poolRequest.pair : [];
    if (debug) console.log(poolData);

    let reserves = (dex === DEX.UniswapV3) ? Number(poolData.totalValueLockedUSD) :
                   (dex === DEX.Sushiswap) ? Number(poolData.reserveUSD) : 0;
    if (poolData.token1Price != 0 && poolData.token0Price != 0 && reserves > MIN_TVL) {
      let vertex0 = g.getVertexByKey(poolData.token0.id);
      let vertex1 = g.getVertexByKey(poolData.token1.id);

      let token1Price = Number(poolData.token1Price);
      let token0Price = Number(poolData.token0Price);
      let fee = Number(poolData.feeTier)
      let forwardEdge = new GraphEdge(vertex0, vertex1, -Math.log(Number(token1Price)), token1Price * (1 + SLIPPAGE + LENDING_FEE), { dex: dex, address: pool, fee: fee });
      let backwardEdge = new GraphEdge(vertex1, vertex0, -Math.log(Number(token0Price)), token0Price * (1 + SLIPPAGE + LENDING_FEE), { dex: dex, address: pool, fee: fee });

      let forwardEdgeExists = g.findEdge(vertex0, vertex1);
      let backwardEdgeExists = g.findEdge(vertex1, vertex0);

      if (forwardEdgeExists) {
        if (forwardEdgeExists.rawWeight < forwardEdge.rawWeight) {
          if (debug) console.log(`replacing: ${poolData.token0.symbol}->${poolData.token1.symbol} from ${forwardEdgeExists.rawWeight} to ${forwardEdge.rawWeight}`)
          g.deleteEdge(forwardEdgeExists);
          g.addEdge(forwardEdge);
        }
      } else {
        g.addEdge(forwardEdge);
      }

      if (backwardEdgeExists) {
        if (backwardEdgeExists.rawWeight < backwardEdge.rawWeight) {
          if (debug) console.log(`replacing: ${poolData.token1.symbol}->${poolData.token0.symbol} from ${backwardEdgeExists.rawWeight} to ${backwardEdge.rawWeight}`)
          g.deleteEdge(backwardEdgeExists);
          g.addEdge(backwardEdge);
        }
      } else {
        g.addEdge(backwardEdge);
      }
    }
  }
}

function classifyCycle(g, cycle) {
  let directions = [];

  for (let index = 0; index < cycle.length - 1; index++) {
    let startVertex = g.getVertexByKey(cycle[index]);
    let endVertex = g.getVertexByKey(cycle[index + 1]);
    let edge = g.findEdge(startVertex, endVertex);

    if (edge.rawWeight > 1 + SLIPPAGE + LENDING_FEE) {
      directions.push('buy');
    } else {
      directions.push('sell');
    }
  }

  let buyCount = directions.filter(direction => direction === 'buy').length;
  let sellCount = directions.filter(direction => direction === 'sell').length;

  return (buyCount > sellCount) ? 'buy' : 'sell';
}

async function main(numberTokens: number = 5, DEXs: Set<DEX>, debug: boolean = false) {
  let g: Graph = new Graph(true);

  let defaultDex: DEX = (DEXs.size === 1 && DEXs.has(DEX.Sushiswap)) ? DEX.Sushiswap :
                        (DEXs.size === 1 && DEXs.has(DEX.UniswapV3)) ? DEX.UniswapV3 : DEX.UniswapV3;
  let tokenIds = await fetchTokens(numberTokens, 0, defaultDex);
  tokenIds.forEach(element => {
    g.addVertex(new GraphVertex(element))
  });

  if (DEXs.has(DEX.UniswapV3)) {
    let uniPools: Set<string> = await fetchUniswapPools(tokenIds);
    await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);
  }
  if (DEXs.has(DEX.Sushiswap)) {
    let sushiPools: Set<string> = await fetchSushiswapPools(tokenIds);
    await fetchPoolPrices(g, sushiPools, DEX.Sushiswap, debug);
  }

  let arbitrageData1 = await calcArbitrage(g, 1);
  let arbitrageData2 = await calcArbitrage(g, 2);
  let arbitrageData5 = await calcArbitrage(g, 5);
  let arbitrageData10 = await calcArbitrage(g, 10);
  let arbitrageData15 = await calcArbitrage(g, 15);

  for (let result of arbitrageData1) {
    console.log(`Ciclo: ${result.cycle}`);
    console.log(`Inicio con ${result.initialAmount} unidades, final con ${result.finalAmount.toFixed(2)} unidades, Profit: ${result.cycleWeight.toFixed(2)}`);
    console.log(`Tipo de ciclo: ${result.type}`);
    console.log('---');
  }

  for (let result of arbitrageData10) {
    console.log(`Ciclo: ${result.cycle}`);
    console.log(`Inicio con ${result.initialAmount} unidades, final con ${result.finalAmount.toFixed(2)} unidades, Profit: ${result.cycleWeight.toFixed(2)}`);
    console.log(`Tipo de ciclo: ${result.type}`);
    console.log('---');
  }

  console.log(`There were ${arbitrageData1.length + arbitrageData10.length} arbitrage cycles detected.`);

  printGraphEdges(g);
}

function printGraphEdges(g) {
  let edges = g.getAllEdges();
  for (let edge of edges) {
    console.log(`${edge.startVertex} -> ${edge.endVertex} | ${edge.rawWeight} | DEX: ${edge.metadata.dex}`);
  }
}

export {
  main
}