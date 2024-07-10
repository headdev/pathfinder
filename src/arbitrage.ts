import { request } from 'graphql-request'
import * as UNISWAP from './dex_queries/uniswap';
import * as SUSHISWAP from './dex_queries/sushiswap';

import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge from './graph_library/GraphEdge';
import bellmanFord from './bellman-ford';
import { DEX, MIN_TVL, SLIPPAGE, LENDING_FEE, MINPROFIT } from './constants';
import * as fs from 'fs';

// tokens iniciales para el nodo G, Validos para un flashloan en AAVE : 
const ALLOWED_TOKENS = [
  '0x28424507a5bbfd333006bf08e9b1913f087f7ef4',
  '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6',
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
  '0xfa68fb4628dff1028cfec22b4162fccd0d45efb6',
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39',
  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
  '0xd6df932a45c0f255f85145f286ea0b292b21c90b',
];

interface ArbitrageRoute {
  cycle: string[];
  cycleWeight: number;
  detail: string;
  type: string;
}

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

  console.log(`Tokens:`, top20Tokens);

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

function calculatePathWeight(g, cycle) {
  let cycleWeight = 1.0;
  let detailedCycle = [];

  for (let index = 0; index < cycle.length - 1; index++) {
    let indexNext = index + 1;
    let startVertex = g.getVertexByKey(cycle[index]);
    let endVertex = g.getVertexByKey(cycle[indexNext]);
    let edge = g.findEdge(startVertex, endVertex);

    cycleWeight *= edge.rawWeight * (1 + SLIPPAGE + LENDING_FEE);

    let transactionType = classifyEdge(g, cycle[index], cycle[index + 1]);

    let dexName = edge.metadata.dex === DEX.UniswapV3 ? "Uniswap V3" : "Sushiswap";

    detailedCycle.push({
      start: cycle[index],
      end: cycle[index + 1],
      type: transactionType,
      rawWeight: edge.rawWeight,
      dexnombre: dexName,
      dex: edge.metadata.dex, 
      poolAddress: edge.metadata.address,
      feeTier: edge.metadata.fee
    });
  }
  return { cycleWeight, detailedCycle };
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
    if (debug) console.log(dex, pool);
    let DEX_ENDPOINT = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : SUSHISWAP.ENDPOINT;
    let DEX_QUERY = (dex === DEX.UniswapV3) ? UNISWAP.fetch_pool(pool) : SUSHISWAP.PAIR(pool);

    let poolRequest = await request(DEX_ENDPOINT, DEX_QUERY);
    console.log("poolRequest", poolRequest);
    
    let poolData = (dex === DEX.UniswapV3) ? poolRequest.pool : poolRequest.pair;
    if (debug) console.log(poolData);

    let reserves = (dex === DEX.UniswapV3) ? Number(poolData.totalValueLockedUSD) : Number(poolData.reserveUSD);
    if (poolData.token1Price != 0 && poolData.token0Price != 0 && reserves > MIN_TVL) {
      let vertex0 = g.getVertexByKey(poolData.token0.id);
      let vertex1 = g.getVertexByKey(poolData.token1.id);

      let token1Price = Number(poolData.token1Price);
      let token0Price = Number(poolData.token0Price);
      let fee = Number(poolData.feeTier);
      
      let forwardEdge = new GraphEdge(vertex0, vertex1, -Math.log(Number(token1Price)), token1Price * (1 + SLIPPAGE + LENDING_FEE), { dex: dex, address: pool, fee: fee });
      let backwardEdge = new GraphEdge(vertex1, vertex0, -Math.log(Number(token0Price)), token0Price * (1 + SLIPPAGE + LENDING_FEE), { dex: dex, address: pool, fee: fee });

      g.addEdge(forwardEdge);
      g.addEdge(backwardEdge);
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

async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
  let arbitrageData: ArbitrageRoute[] = [];
  let uniqueCycle: {[key: string]: boolean} = {};

  g.getAllVertices().forEach((vertex) => {
    let result = bellmanFord(g, vertex);
    let cyclePaths = result.cyclePaths;
    for (var cycle of cyclePaths) {
      let cycleString = cycle.join('');
      let cycleWeight = calculatePathWeight(g, cycle);
      if (!uniqueCycle[cycleString] && cycleWeight.cycleWeight >= 1 + MINPROFIT) {
        uniqueCycle[cycleString] = true;
        let cycleType = classifyCycle(g, cycle);
        arbitrageData.push({
          cycle: cycle,
          cycleWeight: cycleWeight.cycleWeight,
          detail: JSON.stringify(cycleWeight.detailedCycle),
          type: cycleType
        });
      }
    }
  });
  return arbitrageData;
}

function storeArbitrageRoutes(routes: ArbitrageRoute[]) {
  fs.writeFileSync('arbitrageRoutes.json', JSON.stringify(routes, null, 2));
}

async function main(numberTokens: number = 5, DEXs: Set<DEX>, debug: boolean = false) {
  let g: Graph = new Graph(true);

  let tokenIds = new Set<string>();

  // Convertir Set<DEX> a Array
  const dexArray = Array.from(DEXs);

  for (const dex of dexArray) {
    let dexTokenIds = await fetchTokens(numberTokens, 0, dex);
    dexTokenIds.forEach(id => tokenIds.add(id));
  }

  Array.from(tokenIds).forEach(element => {
    g.addVertex(new GraphVertex(element))
  });

  if (DEXs.has(DEX.UniswapV3)) {
    let uniPools: Set<string> = await fetchUniswapPools(Array.from(tokenIds));
    await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);
  }
  if (DEXs.has(DEX.Sushiswap)) {
    let sushiPools: Set<string> = await fetchSushiswapPools(Array.from(tokenIds));
    await fetchPoolPrices(g, sushiPools, DEX.Sushiswap, debug);
  }

  let arbitrageData = await calcArbitrage(g);
  console.log(`Cycles:`, arbitrageData);
  
  console.log(`There were ${arbitrageData.length} arbitrage cycles detected.`);

  storeArbitrageRoutes(arbitrageData);

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