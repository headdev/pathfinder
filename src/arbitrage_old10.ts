import { ethers } from 'ethers';
import BigNumber from 'bignumber.js';
import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge, { EdgeMetadata } from './graph_library/GraphEdge';
import bellmanFord from './bellman-ford';
import {
  DEX,
  MIN_TVL,
  SLIPPAGE,
  LENDING_FEE,
  MINPROFIT,
  FEE_TEIR_PERCENTAGE_OBJECT,
  QUOTER_CONTRACT_ADDRESS,
  UNISWAP_V2_SUSHSISWAP_ABI
} from './constants';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { createObjectCsvWriter } from 'csv-writer';

dotenv.config();

const RATE_LIMIT = 125; // requests per second
const USDT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeAddress(address: string): string {
  return ethers.getAddress(address.toLowerCase());
}

const INITIAL_MATIC = ethers.parseUnits('100', 'gwei');
const FLASH_LOAN_FEE = new BigNumber(0.0005); // 0.05% as 5 basis points
const WMATIC_ADDRESS = safeAddress('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270');

const ALLOWED_TOKENS = [
"0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
"0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
"0xfa68fb4628dff1028cfec22b4162fccd0d45efb6",
"0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
"0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
"0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
"0x03b54a6e9a984069379fae1a4fc4dbae93b3bccd",
"0x3a58a54c066fdc0f2d55fc9c89f0415c92ebf3c4",
"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
"0xe111178a87a3bff0c8d18decba5798827539ae99",
"0x0A15232784220D0999b1b2B54CCbCA54079BFcd7",

].map(address => safeAddress(address));

const UNISWAP_V3_FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

const UNISWAP_V3_POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)"
];

const SUSHISWAP_FACTORY_ADDRESS = '0xc35DADB65012eC5796536bD9864eD8773aBc74C4';
const SUSHISWAP_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const SUSHISWAP_PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const RPC_ENDPOINTS = [
  "https://bold-black-road.matic.quiknode.pro/256dc2c56afd0b5bc32d7c424c3b8c67eb93ad40/",
  // Add more endpoints here
];

let currentEndpointIndex = 0;

function getNextProvider() {
  currentEndpointIndex = (currentEndpointIndex + 1) % RPC_ENDPOINTS.length;
  return new ethers.JsonRpcProvider(RPC_ENDPOINTS[currentEndpointIndex]);
}

let provider = getNextProvider();

const uniswapV3Factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
const sushiswapFactory = new ethers.Contract(SUSHISWAP_FACTORY_ADDRESS, SUSHISWAP_FACTORY_ABI, provider);

interface ArbitrageRoute {
  cycle: string[];
  cycleWeight: string;
  detail: string;
  type: string;
  calculo1?: string;
  montomaxflashloan?: string;
  estimatedProfit?: string;
  isRentable?: boolean;
  mixedDEXs?: boolean;
}

class RateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private processing = false;

  constructor(private limit: number) {}

  async add(fn: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(async () => {
        await fn();
        resolve();
      });
      if (!this.processing) {
        this.process();
      }
    });
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.limit);
      await Promise.all(batch.map(fn => fn()));
      await delay(1000); // Wait for 1 second before processing the next batch
    }
    this.processing = false;
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT);

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const abi = ['function decimals() view returns (uint8)'];
  const contract = new ethers.Contract(tokenAddress, abi, provider);
  try {
    const decimals = await contract.decimals();
    return decimals;
  } catch (error) {
    console.error(`Error obteniendo decimales para ${tokenAddress}:`, error);
    return 18; // Default a 18 si no se puede obtener
  }
}

async function fetchUniswapV3Pools(tokenIds: string[]): Promise<Set<string>> {
  const pools = new Set<string>();
  const fees = [500, 3000, 10000];

  for (let i = 0; i < tokenIds.length; i++) {
    for (let j = i + 1; j < tokenIds.length; j++) {
      for (const fee of fees) {
        await rateLimiter.add(async () => {
          const pool = await uniswapV3Factory.getPool(tokenIds[i], tokenIds[j], fee);
          if (pool !== ethers.ZeroAddress) {
            pools.add(pool);
          }
        });
      }
    }
  }

  console.log(`Uniswap V3 pools found: ${pools.size}`);
  return pools;
}

async function fetchSushiswapPools(tokenIds: string[]): Promise<Set<string>> {
  const pools = new Set<string>();

  for (let i = 0; i < tokenIds.length; i++) {
    for (let j = i + 1; j < tokenIds.length; j++) {
      await rateLimiter.add(async () => {
        const pair = await sushiswapFactory.getPair(tokenIds[i], tokenIds[j]);
        if (pair !== ethers.ZeroAddress) {
          pools.add(pair);
        }
      });
    }
  }

  console.log(`Sushiswap pools found: ${pools.size}`);
  return pools;
}

async function getUniswapV3PoolData(poolAddress: string): Promise<{ price: BigNumber, liquidity: BigNumber, token0: string, token1: string, feeTier: BigNumber }> {
  const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

  try {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    const [sqrtPriceX96, , , , , ] = await poolContract.slot0();
    const liquidity = await poolContract.liquidity();
    const feeTier = await poolContract.fee();

    const price = new BigNumber(sqrtPriceX96.toString()).pow(2).div(new BigNumber(2).pow(192));

    return {
      price,
      liquidity: new BigNumber(liquidity.toString()),
      token0: ethers.getAddress(token0),
      token1: ethers.getAddress(token1),
      feeTier: new BigNumber(feeTier.toString())
    };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de Uniswap V3 ${poolAddress}:`, error);
    return { price: new BigNumber(0), liquidity: new BigNumber(0), token0: '', token1: '', feeTier: new BigNumber(0) };
  }
}

async function getSushiswapPoolData(poolAddress: string): Promise<{ price: BigNumber, liquidity: BigNumber, token0: string, token1: string }> {
  const poolContract = new ethers.Contract(poolAddress, SUSHISWAP_PAIR_ABI, provider);

  try {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    const [reserve0, reserve1] = await poolContract.getReserves();

    const price = new BigNumber(reserve1.toString()).div(new BigNumber(reserve0.toString()));
    const liquidity = new BigNumber(reserve0.toString()).plus(new BigNumber(reserve1.toString()));

    return { 
      price, 
      liquidity, 
      token0: ethers.getAddress(token0), 
      token1: ethers.getAddress(token1) 
    };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de Sushiswap/Uniswap V2 ${poolAddress}:`, error);
    return { price: new BigNumber(0), liquidity: new BigNumber(0), token0: '', token1: '' };
  }
}

async function fetchPoolDataWithExponentialBackoff(poolAddress: string, dex: DEX, maxRetries: number = 5): Promise<{ price: BigNumber, liquidity: BigNumber, token0: string, token1: string, feeTier?: BigNumber }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (dex === DEX.UniswapV3) {
        return await getUniswapV3PoolData(poolAddress);
      } else {
        return await getSushiswapPoolData(poolAddress);
      }
    } catch (error) {
      if (error.code === 'UNKNOWN_ERROR' && error.error && error.error.code === -32007) {
        const backoffTime = Math.pow(2, attempt) * 1000; // Exponential backoff
        console.warn(`Rate limit reached. Retrying in ${backoffTime}ms...`);
        await delay(backoffTime);
        provider = getNextProvider(); // Rotate to next provider
      } else {
        throw error; // If it's not a rate limit error, throw it immediately
      }
    }
  }
  throw new Error(`Failed to fetch pool data for ${poolAddress} after ${maxRetries} attempts`);
}

async function fetchPoolPrices(g: Graph, uniPools: Set<string>, sushiPools: Set<string>, debug: boolean = false): Promise<void> {
  const MIN_PRICE = new BigNumber(1).times(new BigNumber(10).pow(18)).div(1000000);

  async function processPool(pool: string, dex: DEX) {
    try {
      if (debug) console.log(dex, pool);

      let poolData = await fetchPoolDataWithExponentialBackoff(pool, dex);
      const { price, liquidity, token0, token1, feeTier } = poolData;

      if (price.lte(MIN_PRICE)) {
        console.warn(`Price is below threshold for pool ${pool}`);
        return;
      }

      if (!g.getVertexByKey(token0)) g.addVertex(new GraphVertex(token0));
      if (!g.getVertexByKey(token1)) g.addVertex(new GraphVertex(token1));

      let vertex0 = g.getVertexByKey(token0);
      let vertex1 = g.getVertexByKey(token1);

      let metadata: EdgeMetadata = dex === DEX.UniswapV3
        ? { dex, address: pool, liquidity: liquidity.toString(), fee: Number(feeTier.div(1000000).toString()), feeTier: Number(feeTier.toString()) }
        : { dex, address: pool, liquidity: liquidity.toString(), fee: 0.003 };

      updateOrAddEdge(g, vertex0, vertex1, -Math.log(Number(price.toString())), price, metadata);
      updateOrAddEdge(g, vertex1, vertex0, -Math.log(1 / Number(price.toString())), new BigNumber(1e18).div(price), metadata);
    } catch (error) {
      console.error(`Error fetching pool ${pool} for ${dex}:`, error);
    }
  }

  const poolPromises = [
    ...Array.from(uniPools).map(pool => processPool(pool, DEX.UniswapV3)),
    ...Array.from(sushiPools).map(pool => processPool(pool, DEX.Sushiswap))
  ];

  await Promise.all(poolPromises);

  console.log(`Finished processing ${uniPools.size + sushiPools.size} pools`);
}

function updateOrAddEdge(g: Graph, startVertex: GraphVertex, endVertex: GraphVertex, weight: number, rawWeight: BigNumber, metadata: EdgeMetadata): void {
  if (!startVertex || !endVertex) {
    console.warn(`Cannot add edge: one or both vertices do not exist`);
    return;
  }

  const existingEdge = g.findEdge(startVertex, endVertex);
  if (existingEdge) {
    if (weight < existingEdge.weight) {
      existingEdge.weight = weight;
      existingEdge.rawWeight = Number(rawWeight.toString());
      existingEdge.metadata = metadata;
    }
  } else {
    g.addEdge(new GraphEdge(startVertex, endVertex, weight, Number(rawWeight.toString()), metadata));
  }
}

function calculatePathWeight(g: Graph, cycle: string[]): { cycleWeight: BigNumber, detailedCycle: any[] } {
  let cycleWeight = new BigNumber(1e18);
  let detailedCycle = [];

  for (let index = 0; index < cycle.length - 1; index++) {
    let indexNext = index + 1;
    let startVertex = g.getVertexByKey(cycle[index]);
    let endVertex = g.getVertexByKey(cycle[indexNext]);
    let edge = g.findEdge(startVertex, endVertex);

    const fee = new BigNumber(Math.floor(edge.metadata.fee * 1e18));
    cycleWeight = cycleWeight.times(new BigNumber(1e18).minus(fee)).div(new BigNumber(1e18));
    cycleWeight = cycleWeight.times(new BigNumber(edge.rawWeight.toString()));

    let transactionType = new BigNumber(edge.rawWeight.toString()).gt(new BigNumber(1e18)) ? 'buy' : 'sell';
    let dexName = edge.metadata.dex === DEX.UniswapV3 ? "Uniswap V3" : "Sushiswap";

    detailedCycle.push({
      start: cycle[index],
      end: cycle[indexNext],
      type: transactionType,
      rawWeight: edge.rawWeight.toString(),
      dexnombre: dexName,
      dex: edge.metadata.dex,
      poolAddress: edge.metadata.address,
      feeTier: edge.metadata.feeTier || 0
    });
  }
  return { cycleWeight, detailedCycle };
}

async function calcArbitrage(g: Graph, maxDepth: number = 4): Promise<ArbitrageRoute[]> {
  console.log("Starting arbitrage calculation...");
  let arbitrageData: ArbitrageRoute[] = [];
  let uniqueCycle: {[key: string]: boolean} = {};

  for (const vertex of g.getAllVertices()) {
    console.log(`Calculating for vertex: ${vertex.getKey()}`);
    let result = bellmanFord(g, vertex, maxDepth);
    let cyclePaths = result.cyclePaths;
    console.log(`Found ${cyclePaths.length} cycle paths for vertex ${vertex.getKey()}`);
    for (const cycle of cyclePaths) {
      let cycleString = cycle.join('');
      let { cycleWeight, detailedCycle } = calculatePathWeight(g, cycle);
      if (!uniqueCycle[cycleString] && cycleWeight.gt(new BigNumber(1e18).plus(new BigNumber(MINPROFIT * 1e18)))) {
        uniqueCycle[cycleString] = true;
        let cycleType = cycleWeight.gt(new BigNumber(1e18)) ? 'buy' : 'sell';
        
        const dexes = new Set(detailedCycle.map(step => step.dex));
        const mixedDEXs = dexes.size > 1;

        arbitrageData.push({
          cycle: cycle,
          cycleWeight: cycleWeight.toString(),
          detail: JSON.stringify(detailedCycle),
          type: cycleType,
          mixedDEXs
        });
      }
    }
  }
  console.log(`Arbitrage calculation complete. Found ${arbitrageData.length} opportunities.`);
  return arbitrageData;
}

async function calculateInitialAmounts(startToken: string): Promise<{ calculo1: string, montomaxflashloan: string }> {
  startToken = safeAddress(startToken);
  try {
    const pool = await findPoolForTokenPair(WMATIC_ADDRESS, startToken);
    if (!pool) {
      console.warn(`No se encontró una pool para WMATIC-${startToken}`);
      return { calculo1: '0', montomaxflashloan: '0' };
    }

    const { price } = await getUniswapV3PoolData(pool);
    if (price.isZero()) {
      console.warn("Price is zero, cannot calculate initial amounts");
      return { calculo1: '0', montomaxflashloan: '0' };
    }

    const wmaticDecimals = await getTokenDecimals(WMATIC_ADDRESS);
    const startTokenDecimals = await getTokenDecimals(startToken);

    console.log(`Price of WMATIC to ${startToken}: ${price.toString()}`);

    const calculo1 = new BigNumber(100)
      .times(new BigNumber(10).pow(wmaticDecimals))
      .times(price)
      .div(new BigNumber(10).pow(startTokenDecimals));
    const montomaxflashloan = calculo1.div(new BigNumber(1).minus(FLASH_LOAN_FEE));

    console.log(`Calculo1: ${calculo1.toString()}`);
    console.log(`Montomaxflashloan: ${montomaxflashloan.toString()}`);

    return {
      calculo1: calculo1.toFixed(startTokenDecimals),
      montomaxflashloan: montomaxflashloan.toFixed(startTokenDecimals)
    };
  } catch (error) {
    console.error('Error in calculateInitialAmounts:', error);
    return { calculo1: '0', montomaxflashloan: '0' };
  }
}

async function findPoolForTokenPair(token0: string, token1: string): Promise<string | null> {
  const fees = [500, 3000, 10000];
  for (const fee of fees) {
    const pool = await uniswapV3Factory.getPool(token0, token1, fee);
    if (pool !== ethers.ZeroAddress) {
      return pool;
    }
  }
  return null;
}

async function calculateRouteProfit(route: ArbitrageRoute, amount: string): Promise<string> {
  let currentAmount = new BigNumber(amount);
  const steps = JSON.parse(route.detail);

  for (const step of steps) {
    try {
      step.poolAddress = safeAddress(step.poolAddress);
      let price: BigNumber;
      let fee: BigNumber;
      let fromDecimals: number;
      let toDecimals: number;
      let token0: string;
      let token1: string;

      fromDecimals = await getTokenDecimals(step.start);
      toDecimals = await getTokenDecimals(step.end);

      if (step.dex === DEX.UniswapV3) {
        const poolData = await getUniswapV3PoolData(step.poolAddress);
        price = poolData.price;
        fee = poolData.feeTier.div(new BigNumber(1e6));
        token0 = poolData.token0;
        token1 = poolData.token1;
      } else if (step.dex === DEX.Sushiswap || step.dex === DEX.uniswapV2) {
        const poolData = await getSushiswapPoolData(step.poolAddress);
        price = poolData.price;
        fee = new BigNumber(0.003);
        token0 = poolData.token0;
        token1 = poolData.token1;
      } else {
        throw new Error(`Unknown DEX: ${step.dex}`);
      }

      if (step.start.toLowerCase() !== token0.toLowerCase()) {
        price = new BigNumber(1).div(price);
      }

      console.log(`Step: ${step.type}, Price: ${price.toString()}, Fee: ${fee.toString()}`);

      if (step.type === "buy") {
        currentAmount = currentAmount
          .times(new BigNumber(1).minus(fee))
          .times(new BigNumber(10).pow(toDecimals))
          .div(price)
          .div(new BigNumber(10).pow(fromDecimals));
      } else {
        currentAmount = currentAmount
          .times(price)
          .times(new BigNumber(1).minus(fee))
          .times(new BigNumber(10).pow(toDecimals))
          .div(new BigNumber(10).pow(fromDecimals));
      }

      console.log(`Current Amount after step: ${currentAmount.toString()}`);
    } catch (error) {
      console.error(`Error en el paso ${step.dex}:`, error);
      return '0';
    }
  }

  const initialAmount = new BigNumber(amount);
  const profit = currentAmount.minus(initialAmount);
  const finalDecimals = await getTokenDecimals(route.cycle[0]);
  return profit.toFixed(finalDecimals);
}

async function processArbitrageRoutes(routes: ArbitrageRoute[]): Promise<ArbitrageRoute[]> {
  const processedRoutes: ArbitrageRoute[] = [];

  for (const route of routes) {
    try {
      const { calculo1, montomaxflashloan } = await calculateInitialAmounts(route.cycle[0]);
      if (calculo1 === '0' || montomaxflashloan === '0') {
        continue;
      }
      const estimatedProfit = await calculateRouteProfit(route, montomaxflashloan);
      
      const startTokenDecimals = await getTokenDecimals(route.cycle[0]);

      const profitBN = new BigNumber(estimatedProfit);
      const montomaxflashloanBN = new BigNumber(montomaxflashloan);
      const lendingFeeBN = new BigNumber(LENDING_FEE);

      const profitAfterLendingFee = profitBN.minus(montomaxflashloanBN.times(lendingFeeBN));
      const isRentable = profitAfterLendingFee.gt(0);

      processedRoutes.push({
        ...route,
        calculo1,
        montomaxflashloan,
        estimatedProfit: profitAfterLendingFee.toFixed(startTokenDecimals),
        isRentable,
        mixedDEXs: route.mixedDEXs
      });

      console.log(`Ruta procesada:`);
      console.log(`  Ciclo: ${route.cycle.join(' -> ')}`);
      console.log(`  Tipo: ${route.type}`);
      console.log(`  DEXs mezclados: ${route.mixedDEXs ? 'Sí' : 'No'}`);
      console.log(`  Monto inicial: ${calculo1}`);
      console.log(`  Monto máximo flash loan: ${montomaxflashloan}`);
      console.log(`  Beneficio estimado: ${profitAfterLendingFee.toFixed(startTokenDecimals)}`);
      console.log(`  Es rentable: ${isRentable ? 'Sí' : 'No'}`);
      console.log(`  Detalles: ${route.detail}`);
      console.log('');

    } catch (error) {
      console.error(`Error procesando ruta:`, error);
    }
  }

  processedRoutes.sort((a, b) => 
    new BigNumber(b.estimatedProfit || '0').minus(new BigNumber(a.estimatedProfit || '0')).toNumber()
  );

  console.log(`Total de rutas procesadas: ${processedRoutes.length}`);
  console.log(`Top 5 rutas más rentables:`);
  processedRoutes.slice(0, 5).forEach((route, index) => {
    console.log(`${index + 1}. Beneficio: ${route.estimatedProfit}, Ciclo: ${route.cycle.join(' -> ')}`);
  });

  return processedRoutes;
}

async function fetchTokenPrices(tokenIds: string[]): Promise<Map<string, { uniswapPrice: BigNumber, sushiswapPrice: BigNumber }>> {
  const prices = new Map<string, { uniswapPrice: BigNumber, sushiswapPrice: BigNumber }>();

  for (const tokenId of tokenIds) {
    if (tokenId === USDT_ADDRESS) continue;

    await rateLimiter.add(async () => {
      try {
        const uniswapPool = await findPoolForTokenPair(tokenId, USDT_ADDRESS);
        const sushiswapPool = await sushiswapFactory.getPair(tokenId, USDT_ADDRESS);

        let uniswapPrice = new BigNumber(0);
        let sushiswapPrice = new BigNumber(0);

        if (uniswapPool) {
          const { price } = await getUniswapV3PoolData(uniswapPool);
          uniswapPrice = price;
        }

        if (sushiswapPool !== ethers.ZeroAddress) {
          const { price } = await getSushiswapPoolData(sushiswapPool);
          sushiswapPrice = price;
        }

        // Solo agregar tokens con al menos un precio válido
        if (!uniswapPrice.isZero() || !sushiswapPrice.isZero()) {
          prices.set(tokenId, { uniswapPrice, sushiswapPrice });
          console.log(`Token ${tokenId} prices: Uniswap: ${uniswapPrice.toString()}, Sushiswap: ${sushiswapPrice.toString()}`);
        } else {
          console.log(`Token ${tokenId} has no valid prices on either DEX`);
        }
      } catch (error) {
        console.error(`Error fetching prices for token ${tokenId}:`, error);
      }
    });
  }

  return prices;
}

async function savePricesToCSV(prices: Map<string, { uniswapPrice: BigNumber, sushiswapPrice: BigNumber }>) {
  const csvWriter = createObjectCsvWriter({
    path: 'token_prices.csv',
    header: [
      { id: 'token', title: 'Token Address' },
      { id: 'uniswapPrice', title: 'Uniswap Price (USDT)' },
      { id: 'sushiswapPrice', title: 'Sushiswap Price (USDT)' },
    ],
  });

  const records = Array.from(prices.entries()).map(([token, { uniswapPrice, sushiswapPrice }]) => ({
    token,
    uniswapPrice: uniswapPrice.toString(),
    sushiswapPrice: sushiswapPrice.toString(),
  }));

  await csvWriter.writeRecords(records);
  console.log('Token prices saved to token_prices.csv');
}

async function main(numberTokens: number = 16, debug: boolean = false) {
  try {
    console.log("Iniciando el proceso de arbitraje...");

    const tokenIds = ALLOWED_TOKENS.slice(0, numberTokens);
    console.log(`Se usarán ${tokenIds.length} tokens.`);

    console.log("Obteniendo precios de tokens...");
    const tokenPrices = await fetchTokenPrices(tokenIds);
    await savePricesToCSV(tokenPrices);

    let g: Graph = new Graph(true);
    tokenIds.forEach(id => g.addVertex(new GraphVertex(safeAddress(id))));
    console.log("Grafo inicializado.");

    console.log("Obteniendo pools y precios...");
    const uniPools = await fetchUniswapV3Pools(tokenIds);
    const sushiPools = await fetchSushiswapPools(tokenIds);
    await fetchPoolPrices(g, uniPools, sushiPools, debug);

    console.log("Calculando rutas de arbitraje...");
    const arbitrageRoutes = await calcArbitrage(g);
    console.log(`Se encontraron ${arbitrageRoutes.length} rutas de arbitraje potenciales.`);

    console.log("Procesando y analizando rutas...");
    const processedRoutes = await processArbitrageRoutes(arbitrageRoutes);

    const filePath = path.join(__dirname, 'arbitrageRoutes.json');
    fs.writeFileSync(filePath, JSON.stringify(processedRoutes, null, 2));
    console.log(`Resultados guardados en ${filePath}`);

    console.log(`Proceso completado. Se procesaron ${processedRoutes.length} rutas de arbitraje.`);
  } catch (error) {
    console.error("Error en la ejecución principal:", error);
  }
}

if (require.main === module) {
  main(16, true)
    .then(() => console.log("Script completed successfully"))
    .catch(error => console.error("An error occurred during execution:", error));
}