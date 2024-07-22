// nuevo con optimizador
import { request } from 'graphql-request'
import * as UNISWAP from './dex_queries/uniswap';
import * as SUSHISWAP from './dex_queries/sushiswap';
const { check_all_structured_paths } = require('.//profitability_checks/intial_check');
import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge from './graph_library/GraphEdge';
import bellmanFord from './bellman-ford';
import { DEX, MIN_TVL, SLIPPAGE, LENDING_FEE, MINPROFIT } from './constants';
import * as fs from 'fs';
import * as path from 'path';
import { get_amount_out_from_uniswap_V3, get_amount_out_from_uniswap_V2_and_sushiswap } from './profitability_checks/on_chain_check';
import { ethers } from 'ethers';

const INITIAL_MATIC = 100;
const AAVE_INTEREST_RATE = 0.0005; // 0.05%
const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

// tokens iniciales para el nodo G, Validos para un flashloan en AAVE : 
const ALLOWED_TOKENS = [
  '0x28424507a5bbfd333006bf08e9b1913f087f7ef4',
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
  initialAmount?: number;
  maxLoanAmount?: number;
  estimatedProfit?: number;
  profitsByAmount?: { amount: number; profit: number }[];
}

interface ImprovedArbitrageRoute extends ArbitrageRoute {
  steps: {
    from: string;
    to: string;
    type: string;
    exchange: string;
    poolAddress: string;
    feeTier: number;
  }[];
}

async function fetchTokens(first: number, dexes: DEX[]): Promise<string[]> {
  let allTokens = new Map<string, { id: string, volume: number }>();

  for (const dex of dexes) {
    let dexEndpoint = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : SUSHISWAP.ENDPOINT;
    let tokensQuery = (dex === DEX.UniswapV3) ? UNISWAP.HIGHEST_VOLUME_TOKENS(first) : SUSHISWAP.HIGHEST_VOLUME_TOKENS(first, 0);
    
    try {
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
    } catch (error) {
      console.error(`Error fetching tokens for ${dex}:`, error);
    }
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

        // Check if edges already exist
        let existingForwardEdge = g.findEdge(vertex0, vertex1);
        let existingBackwardEdge = g.findEdge(vertex1, vertex0);

        if (existingForwardEdge) {
          // Update existing edge if new edge is better
          if (forwardEdge.weight < existingForwardEdge.weight) {
            g.deleteEdge(existingForwardEdge);
            g.addEdge(forwardEdge);
          }
        } else {
          g.addEdge(forwardEdge);
        }

        if (existingBackwardEdge) {
          // Update existing edge if new edge is better
          if (backwardEdge.weight < existingBackwardEdge.weight) {
            g.deleteEdge(existingBackwardEdge);
            g.addEdge(backwardEdge);
          }
        } else {
          g.addEdge(backwardEdge);
        }
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


async function calculateInitialAmount(originTokenAddress: string): Promise<number> {
  try {
    const maticToOriginToken = await get_amount_out_from_uniswap_V3({
      token0: { id: WMATIC_ADDRESS },
      token1: { id: originTokenAddress },
      token_in: WMATIC_ADDRESS,
      token_out: originTokenAddress,
      fee: 3000 // Asume un fee de 0.3%, ajusta según sea necesario
    }, INITIAL_MATIC.toString());

    if (maticToOriginToken === undefined) {
      console.error('get_amount_out_from_uniswap_V3 returned undefined');
      return 0;
    }

    return parseFloat(maticToOriginToken);
  } catch (error) {
    console.error('Error in calculateInitialAmount:', error);
    return 0;
  }
}

function calculateMaxLoanAmount(initialAmount: number): number {
  if (isNaN(initialAmount) || initialAmount <= 0) {
    console.error('Invalid initialAmount in calculateMaxLoanAmount:', initialAmount);
    return 0;
  }
  return initialAmount / AAVE_INTEREST_RATE;
}

async function calculateRouteProfit(route: ArbitrageRoute, amount: number): Promise<number> {
  if (isNaN(amount) || amount <= 0) {
    console.error('Invalid amount in calculateRouteProfit:', amount);
    return 0;
  }

  let currentAmount = amount;
  const steps = JSON.parse(route.detail);

  for (const step of steps) {
    try {
      let result;
      if (step.dexnombre === "Uniswap V3") {
        result = await get_amount_out_from_uniswap_V3({
          token0: { id: step.start },
          token1: { id: step.end },
          token_in: step.start,
          token_out: step.end,
          fee: step.feeTier
        }, currentAmount.toString());
      } else {
        result = await get_amount_out_from_uniswap_V2_and_sushiswap({
          token0: { id: step.start },
          token1: { id: step.end },
          token_in: step.start,
          token_out: step.end,
          exchange: step.dexnombre.toLowerCase()
        }, currentAmount.toString());
      }

      if (result === undefined) {
        console.error('get_amount_out returned undefined for step:', step);
        return 0;
      }

      currentAmount = parseFloat(result);

      if (isNaN(currentAmount)) {
        console.error('Invalid currentAmount after step:', step);
        return 0;
      }
    } catch (error) {
      console.error('Error in calculateRouteProfit step:', error);
      return 0;
    }
  }

  return currentAmount - amount;
}

async function calculateProfitsForDifferentAmounts(route: ArbitrageRoute, maxLoanAmount: number): Promise<{ amount: number; profit: number }[]> {
  const amounts = [
    maxLoanAmount / 5,
    maxLoanAmount / 4,
    maxLoanAmount / 3,
    maxLoanAmount / 2,
    maxLoanAmount
  ];

  const profitsByAmount = await Promise.all(
    amounts.map(async (amount) => ({
      amount,
      profit: await calculateRouteProfit(route, amount)
    }))
  );

  return profitsByAmount;
}
async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
  console.log("Starting arbitrage calculation...");
  let arbitrageData: ArbitrageRoute[] = [];
  let uniqueCycle: {[key: string]: boolean} = {};

  for (const vertex of g.getAllVertices()) {
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
        let route: ArbitrageRoute = {
          cycle: cycle,
          cycleWeight: cycleWeight.cycleWeight,
          detail: JSON.stringify(cycleWeight.detailedCycle),
          type: cycleType
        };
        
        // Calcular el monto inicial
        const initialAmount = await calculateInitialAmount(cycle[0]);
        
        // Calcular el monto máximo a prestar
        const maxLoanAmount = calculateMaxLoanAmount(initialAmount);
        
        // Calcular los profits para diferentes montos
        const profitsByAmount = await calculateProfitsForDifferentAmounts(route, maxLoanAmount);
        
        // Encontrar el mejor profit
        const bestProfit = profitsByAmount.reduce((max, current) => 
          current.profit > max.profit ? current : max, { amount: 0, profit: 0 }
        );
        
        if (!isNaN(initialAmount) && !isNaN(maxLoanAmount) && !isNaN(bestProfit.profit)) {
          arbitrageData.push({
            ...route,
            initialAmount: initialAmount,
            maxLoanAmount: maxLoanAmount,
            estimatedProfit: bestProfit.profit,
            profitsByAmount: profitsByAmount
          });
        } else {
          console.error('Invalid calculation results:', { initialAmount, maxLoanAmount, bestProfit });
        }
      }
    }
  }
  console.log(`Arbitrage calculation complete. Found ${arbitrageData.length} opportunities.`);
  return arbitrageData;
}

function improveRouteFormat(route: ArbitrageRoute): ImprovedArbitrageRoute {
  const steps = JSON.parse(route.detail);
  return {
    ...route,
    steps: steps.map(step => ({
      from: step.start,
      to: step.end,
      type: step.type,
      exchange: step.dexnombre,
      poolAddress: step.poolAddress,
      feeTier: step.feeTier
    }))
  };
}

function storeArbitrageRoutes(routes: ImprovedArbitrageRoute[]) {
  const filePath = path.join(__dirname, 'arbitrageRoutes.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(routes, null, 2));
    console.log(`Arbitrage routes successfully saved to ${filePath}`);
  } catch (error) {
    console.error(`Error saving arbitrage routes to file:`, error);
  }
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

  let improvedArbitrageData = arbitrageData.map(improveRouteFormat);
  storeArbitrageRoutes(improvedArbitrageData);

  // Verificar si el archivo se creó correctamente
  const filePath = path.join(__dirname, 'arbitrageRoutes.json');
  if (fs.existsSync(filePath)) {
    console.log(`arbitrageRoutes.json file was successfully created at ${filePath}`);
  } else {
    console.error(`Failed to create arbitrageRoutes.json file at ${filePath}`);
  }

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