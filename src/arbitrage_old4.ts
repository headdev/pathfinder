import { request } from 'graphql-request'
import * as UNISWAP from './dex_queries/uniswap';
import * as SUSHISWAP from './dex_queries/sushiswap';

import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge from './graph_library/GraphEdge';
import bellmanFord from './bellman-ford';
import { DEX, MIN_TVL, SLIPPAGE, LENDING_FEE,MINPROFIT } from './constants';
import * as fs from 'fs';
import { writeFileSync } from 'fs';


// tokens iniciales para el nodo G, Validos para un flashloan en AAVE : 

const ALLOWED_TOKENS = [
  '0x28424507a5bbfd333006bf08e9b1913f087f7ef4',
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  "0x80cA0d8C38d2e2BcbaB66aA1648Bd1C7160500FE",
  "0x2aeB3AcBEb4C604451C560d89D88d95d54C2C2cC",
  "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32",
  "0xA8C557c7ac1626EacAa0e80fAc7b6997346306E8",
  "0xF07A8Cc2d26a87D6BBcf6e578d7f5202f3ed9642",
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

// Fetch most active tokens 
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

  console.log(Tokens:,  top20Tokens ) //mostActiveTokens.tokens)

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

  // console.log(cycle.length);
  for (let index = 0; index < cycle.length - 1; index++) {
    let indexNext = index + 1;
    // console.log(new indices: ${index} ${indexNext});
    let startVertex = g.getVertexByKey(cycle[index]);
    let endVertex = g.getVertexByKey(cycle[indexNext]);
    let edge = g.findEdge(startVertex, endVertex);

    // console.log(Start: ${startVertex.value} | End: ${endVertex.value})
    // console.log(Adj edge weight: ${edge.weight} | Raw edge weight: ${edge.rawWeight} | ${edge.getKey()});
    // console.log(DEX: ${edge.metadata.dex})
    // console.log(cycleWeight * edge.rawWeight)

    cycleWeight *= edge.rawWeight * (1 + SLIPPAGE + LENDING_FEE);

    let transactionType = classifyEdge(g, cycle[index], cycle[index + 1]);

    let dexName = "";
    if (edge.metadata.dex === DEX.UniswapV3) {
      dexName = "Uniswap V3";
    } else if (edge.metadata.dex === DEX.Sushiswap) {
      dexName = "Sushiswap";
    }


    detailedCycle.push({
      start: cycle[index],
      end: cycle[index + 1],
      type: transactionType,
      rawWeight: edge.rawWeight,
      dexnombre: dexName,
      dex: edge.metadata.dex, 
      poolAddress: edge.metadata.address,
      feeTier: edge.metadata.fee // Añadimos el feeTier aquí
    });

  }
  return { cycleWeight, detailedCycle };;
}

  async function fetchUniswapPools(tokenIds) {
    let pools = new Set<string>();
    let tokenIdsSet = new Set(tokenIds);

    // Fetch whitelist pools
    for (let id of tokenIds) {
      // Query whitelisted pools for token
      let whitelistPoolsRaw = await request(UNISWAP.ENDPOINT, UNISWAP.token_whitelist_pools(id));

      // filtrar por las primeras 20, 

      let whitelistPools = whitelistPoolsRaw.token.whitelistPools;

      // Filter to only
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

  // Fetch pools
  let poolsDataRaw = await request(SUSHISWAP.ENDPOINT, SUSHISWAP.PAIRS(tokenIds));
  let poolsData = poolsDataRaw.pairs;

  // Filter to only
  for (let pool of poolsData) {
    pools.add(pool.id);
  }
  return pools;
}

// 7Fetch prices
/*/async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false) {
  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    if (debug) console.log(dex, pool) //debug
    let DEX_ENDPOINT =  (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT :
                        (dex === DEX.Sushiswap) ? SUSHISWAP.ENDPOINT : "";
    let DEX_QUERY =     (dex === DEX.UniswapV3) ? UNISWAP.fetch_pool(pool) :
                        (dex === DEX.Sushiswap) ? SUSHISWAP.PAIR(pool) : "";;

    let poolRequest = await request(DEX_ENDPOINT, DEX_QUERY);
    console.log("poolRequest", poolRequest);
    
    let poolData =  (dex === DEX.UniswapV3) ? poolRequest.pool :
                    (dex === DEX.Sushiswap) ? poolRequest.pair : [];
    if (debug) console.log(poolData); //debug

    // Some whitelisted pools are inactive for whatever reason
    // Pools exist with tiny TLV values
    let reserves =  (dex === DEX.UniswapV3) ? Number(poolData.totalValueLockedUSD) : 
                    (dex === DEX.Sushiswap) ? Number(poolData.reserveUSD) : 0;
    if (poolData.token1Price != 0 && poolData.token0Price != 0 && reserves > MIN_TVL) {

      let vertex0 = g.getVertexByKey(poolData.token0.id);
      let vertex1 = g.getVertexByKey(poolData.token1.id);

      // TODO: Adjust weight to factor in gas estimates
      let token1Price = Number(poolData.token1Price);
      let token0Price = Number(poolData.token0Price);
      let fee = Number(poolData.feeTier)
      let forwardEdge = new GraphEdge(vertex0, vertex1, -Math.log(Number(token1Price)), token1Price, { dex: dex, address: pool });
      let backwardEdge = new GraphEdge(vertex1, vertex0, -Math.log(Number(token0Price)), token0Price, { dex: dex, address: pool });

      // Temporary solution to multiple pools per pair
      // TODO: Check if edge exists, if yes, replace iff price is more favorable (allows cross-DEX)
      let forwardEdgeExists = g.findEdge(vertex0, vertex1);
      let backwardEdgeExists = g.findEdge(vertex1, vertex0);

      if (forwardEdgeExists) {
        if (forwardEdgeExists.rawWeight < forwardEdge.rawWeight) {
          if (debug) console.log(replacing: ${poolData.token0.symbol}->${poolData.token1.symbol} from ${forwardEdgeExists.rawWeight} to ${forwardEdge.rawWeight})
          g.deleteEdge(forwardEdgeExists);
          g.addEdge(forwardEdge);
        }
      } else {
        g.addEdge(forwardEdge);
      }

      if (backwardEdgeExists) {
        if (backwardEdgeExists.rawWeight < backwardEdge.rawWeight) {
          if (debug) console.log(replacing: ${poolData.token1.symbol}->${poolData.token0.symbol} from ${backwardEdgeExists.rawWeight} to ${backwardEdge.rawWeight})
          g.deleteEdge(backwardEdgeExists);
          g.addEdge(backwardEdge);
        }
      } else {
        g.addEdge(backwardEdge);
      }
    }
  }
}/*/


async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false) {
  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    if (debug) console.log(dex, pool) //debug
    let DEX_ENDPOINT =  (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT :
                        (dex === DEX.Sushiswap) ? SUSHISWAP.ENDPOINT : "";
    let DEX_QUERY =     (dex === DEX.UniswapV3) ? UNISWAP.fetch_pool(pool) :
                        (dex === DEX.Sushiswap) ? SUSHISWAP.PAIR(pool) : "";;

    let poolRequest = await request(DEX_ENDPOINT, DEX_QUERY);
    console.log("poolRequest", poolRequest);
    
    let poolData =  (dex === DEX.UniswapV3) ? poolRequest.pool :
                    (dex === DEX.Sushiswap) ? poolRequest.pair : [];
    if (debug) console.log(poolData); //debug

    let reserves =  (dex === DEX.UniswapV3) ? Number(poolData.totalValueLockedUSD) : 
                    (dex === DEX.Sushiswap) ? Number(poolData.reserveUSD) : 0;
    if (poolData.token1Price != 0 && poolData.token0Price != 0 && reserves > MIN_TVL) {

      let vertex0 = g.getVertexByKey(poolData.token0.id);
      let vertex1 = g.getVertexByKey(poolData.token1.id);

      let token1Price = Number(poolData.token1Price);
      let token0Price = Number(poolData.token0Price);
      let fee = Number(poolData.feeTier) // <-- Incluí esta línea
      let forwardEdge = new GraphEdge(vertex0, vertex1, -Math.log(Number(token1Price)), token1Price * (1 + SLIPPAGE + LENDING_FEE), { dex: dex, address: pool, fee: fee });
      let backwardEdge = new GraphEdge(vertex1, vertex0, -Math.log(Number(token0Price)), token0Price * (1 + SLIPPAGE + LENDING_FEE), { dex: dex, address: pool, fee: fee });

      let forwardEdgeExists = g.findEdge(vertex0, vertex1);
      let backwardEdgeExists = g.findEdge(vertex1, vertex0);

      if (forwardEdgeExists) {
        if (forwardEdgeExists.rawWeight < forwardEdge.rawWeight) {
          if (debug) console.log(replacing: ${poolData.token0.symbol}->${poolData.token1.symbol} from ${forwardEdgeExists.rawWeight} to ${forwardEdge.rawWeight})
          g.deleteEdge(forwardEdgeExists);
          g.addEdge(forwardEdge);
        }
      } else {
        g.addEdge(forwardEdge);
      }

      if (backwardEdgeExists) {
        if (backwardEdgeExists.rawWeight < backwardEdge.rawWeight) {
          if (debug) console.log(replacing: ${poolData.token1.symbol}->${poolData.token0.symbol} from ${backwardEdgeExists.rawWeight} to ${backwardEdge.rawWeight})
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


/**
 * Calculates all arbitrage cycles in given graph
 * @param {*} g - graph
 * @returns array of cycles & negative cycle value
 */

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

  let defaultDex: DEX = (DEXs.size === 1 && DEXs.has(DEX.Sushiswap)) ? DEX.Sushiswap :
                        (DEXs.size === 1 && DEXs.has(DEX.UniswapV3)) ? DEX.UniswapV3 : DEX.UniswapV3;
  let tokenIds = await fetchTokens(numberTokens, 0, defaultDex);
  tokenIds.forEach(element => {
    g.addVertex(new GraphVertex(element))
  })

  if (DEXs.has(DEX.UniswapV3)) {
    let uniPools: Set<string> = await fetchUniswapPools(tokenIds);
    await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);
  }
  if (DEXs.has(DEX.Sushiswap)) {
    let sushiPools: Set<string> = await fetchSushiswapPools(tokenIds);
    await fetchPoolPrices(g, sushiPools, DEX.Sushiswap, debug);
  }

  let arbitrageData = await calcArbitrage(g);
  console.log(Cycles:, arbitrageData);
  
  console.log(There were ${arbitrageData.length} arbitrage cycles detected.);

  storeArbitrageRoutes(arbitrageData);

  printGraphEdges(g);
}

function printGraphEdges(g) {
  let edges = g.getAllEdges();
  for (let edge of edges) {
    console.log(${edge.startVertex} -> ${edge.endVertex} | ${edge.rawWeight} | DEX: ${edge.metadata.dex});
  }
}



export {
  main
}
