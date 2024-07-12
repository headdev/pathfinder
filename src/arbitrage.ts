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

async function fetchTokens(first: number, dexes: DEX[]): Promise<string[]> {
  let allTokens = new Map<string, { id: string, volume: number }>();

  for (const dex of dexes) {
    let dexEndpoint = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : SUSHISWAP.ENDPOINT;
    let tokensQuery = (dex === DEX.UniswapV3) ? UNISWAP.HIGHEST_VOLUME_TOKENS(first) : SUSHISWAP.HIGHEST_VOLUME_TOKENS(first, 0);
    
    let mostActiveTokens = await request(dexEndpoint, tokensQuery);

    if (!mostActiveTokens || !mostActiveTokens.tokens) {
      console.error(`No se encontraron tokens en la respuesta para ${dex}:`, mostActiveTokens);
      continue;
    }

    mostActiveTokens.tokens
      .filter(t => ALLOWED_TOKENS.includes(t.id))
      .forEach(t => {
        if (allTokens.has(t.id)) {
          allTokens.get(t.id).volume += Number(t.volumeUSD);
        } else {
          allTokens.set(t.id, { id: t.id, volume: Number(t.volumeUSD) });
        }
      });
  }

  let sortedTokens = Array.from(allTokens.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, first)
    .map(t => t.id);

  console.log(`Tokens combinados:`, sortedTokens);

  return sortedTokens;
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
  try {
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
    console.log(`Uniswap pools found: ${pools.size}`);
    return pools;
  } catch (error) {
    console.error("Error fetching Uniswap pools:", error);
    return new Set<string>();
  }
}

async function fetchSushiswapPools(tokenIds) {
  try {
    let pools = new Set<string>();
    let poolsDataRaw = await request(SUSHISWAP.ENDPOINT, SUSHISWAP.PAIRS(tokenIds));
    let poolsData = poolsDataRaw.pairs;

    for (let pool of poolsData) {
      pools.add(pool.id);
    }
    console.log(`Sushiswap pools found: ${pools.size}`);
    return pools;
  } catch (error) {
    console.error("Error fetching Sushiswap pools:", error);
    return new Set<string>();
  }
}

async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false) {
  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    try {
      if (debug) console.log(dex, pool);
      let DEX_ENDPOINT = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : SUSHISWAP.ENDPOINT;
      let DEX_QUERY = (dex === DEX.UniswapV3) ? UNISWAP.fetch_pool(pool) : SUSHISWAP.PAIR(pool);

      let poolRequest = await request(DEX_ENDPOINT, DEX_QUERY);
      if (debug) console.log("poolRequest", poolRequest);
      
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

        g.updateEdge(vertex0, vertex1, forwardEdge);
        g.updateEdge(vertex1, vertex0, backwardEdge);
      }
    } catch (error) {
      console.error(`Error fetching pool ${pool} for ${dex}:`, error);
    }
  }
  console.log(`Finished processing ${pools.size} pools for ${dex}`);
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
  console.log("Starting arbitrage calculation...");
  let arbitrageData: ArbitrageRoute[] = [];
  let uniqueCycle: {[key: string]: boolean} = {};

  g.getAllVertices().forEach((vertex) => {
    console.log(`Calculating for vertex: ${vertex.getKey()}`);
    let result = bellmanFord(g, vertex);
    let cyclePaths = result.cyclePaths;
    console.log(`Found ${cyclePaths.length} cycle paths for vertex ${vertex.getKey()}`);
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
  console.log(`Arbitrage calculation complete. Found ${arbitrageData.length} opportunities.`);
  return arbitrageData;
}

function storeArbitrageRoutes(routes: ArbitrageRoute[]) {
  fs.writeFileSync('arbitrageRoutes.json', JSON.stringify(routes, null, 2));
}

async function main(numberTokens: number = 5, DEXs: Set<DEX>, debug: boolean = false) {
  let g: Graph = new Graph(true);

  console.log("Fetching tokens...");
  let tokenIds = await fetchTokens(numberTokens, Array.from(DEXs));
  console.log("Tokens obtained, creating vertices...");

  tokenIds.forEach(id => {
    g.addVertex(new GraphVertex(id))
  });
  console.log("Vertices created. Fetching pools...");

  if (DEXs.has(DEX.UniswapV3)) {
    console.log("Fetching Uniswap V3 pools...");
    let uniPools: Set<string> = await fetchUniswapPools(tokenIds);
    console.log(`Fetched ${uniPools.size} Uniswap V3 pools. Getting prices...`);
    await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);
  }
  if (DEXs.has(DEX.Sushiswap)) {
    console.log("Fetching Sushiswap pools...");
    let sushiPools: Set<string> = await fetchSushiswapPools(tokenIds);
    console.log(`Fetched ${sushiPools.size} Sushiswap pools. Getting prices...`);
    await fetchPoolPrices(g, sushiPools, DEX.Sushiswap, debug);
  }

  console.log("All prices obtained. Calculating arbitrage...");
  let arbitrageData = await calcArbitrage(g);
  console.log(`Cycles:`, arbitrageData);
  
  console.log(`There were ${arbitrageData.length} arbitrage cycles detected.`);

  storeArbitrageRoutes(arbitrageData);

  printGraphEdges(g);
}

function printGraphEdges(g) {
  let edges = g.getAllEdges();
  for (let edge of edges) {
    console.log(`${edge.startVertex.getKey()} -> ${edge.endVertex.getKey()} | ${edge.rawWeight} | DEX: ${edge.metadata.dex}`);
  }
}

main(5, new Set([DEX.UniswapV3, DEX.Sushiswap]), true)
  .then(() => console.log("Script completed successfully"))
  .catch(error => console.error("An error occurred during execution:", error));

export {
  main
}