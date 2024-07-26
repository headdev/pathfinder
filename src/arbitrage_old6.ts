import { ethers } from 'ethers';
import JSBI from 'jsbi';
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

dotenv.config();

const INITIAL_MATIC = ethers.parseUnits('100', 'gwei');
const FLASH_LOAN_FEE = 0.0005; // 0.05%
const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';



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

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const uniswapV3Factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
const sushiswapFactory = new ethers.Contract(SUSHISWAP_FACTORY_ADDRESS, SUSHISWAP_FACTORY_ABI, provider);

interface ArbitrageRoute {
  cycle: string[];
  cycleWeight: number;
  detail: string;
  type: string;
  calculo1?: string;
  montomaxflashloan?: string;
  estimatedProfit?: string;
  isRentable?: boolean;
}

async function fetchUniswapV3Pools(tokenIds: string[]): Promise<Set<string>> {
  const pools = new Set<string>();
  const fees = [500, 3000, 10000]; // Fee tiers de Uniswap V3

  for (let i = 0; i < tokenIds.length; i++) {
    for (let j = i + 1; j < tokenIds.length; j++) {
      for (const fee of fees) {
        const pool = await uniswapV3Factory.getPool(tokenIds[i], tokenIds[j], fee);
        if (pool !== ethers.ZeroAddress) {
          pools.add(pool);
        }
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
      const pair = await sushiswapFactory.getPair(tokenIds[i], tokenIds[j]);
      if (pair !== ethers.ZeroAddress) {
        pools.add(pair);
      }
    }
  }

  console.log(`Sushiswap pools found: ${pools.size}`);
  return pools;
}

async function getUniswapV3PoolData(poolAddress: string): Promise<{ price: number, liquidity: string, token0: string, token1: string, feeTier: number }> {
  const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

  try {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    const [sqrtPriceX96, , , , , ] = await poolContract.slot0();
    const liquidity = await poolContract.liquidity();
    const feeTier = await poolContract.fee();

    const price = Math.pow(Number(sqrtPriceX96) / Math.pow(2, 96), 2);

    if (price === 0) {
      console.warn(`Price is zero for pool ${poolAddress}`);
      return { price: 0, liquidity: '0', token0, token1, feeTier };
    }

    return { price, liquidity: liquidity.toString(), token0, token1, feeTier };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de Uniswap V3 ${poolAddress}:`, error);
    return { price: 0, liquidity: '0', token0: '', token1: '', feeTier: 0 };
  }
}

async function getSushiswapPoolData(poolAddress: string): Promise<{ price: number, liquidity: string, token0: string, token1: string }> {
  const poolContract = new ethers.Contract(poolAddress, SUSHISWAP_PAIR_ABI, provider);

  try {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    const [reserve0, reserve1] = await poolContract.getReserves();

    const price = Number(reserve1) / Number(reserve0);
    const liquidity = ethers.formatUnits(reserve0.add(reserve1), 'ether');

    if (price === 0) {
      console.warn(`Price is zero for pool ${poolAddress}`);
      return { price: 0, liquidity: '0', token0, token1 };
    }

    return { price, liquidity, token0, token1 };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de Sushiswap ${poolAddress}:`, error);
    return { price: 0, liquidity: '0', token0: '', token1: '' };
  }
}



async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false): Promise<void> {
  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    try {
      if (debug) console.log(dex, pool);
      
      if (dex === DEX.UniswapV3) {
        const { price, liquidity, token0, token1, feeTier } = await getUniswapV3PoolData(pool);
        if (price === 0) continue;

        if (!g.getVertexByKey(token0)) {
          g.addVertex(new GraphVertex(token0));
        }
        if (!g.getVertexByKey(token1)) {
          g.addVertex(new GraphVertex(token1));
        }

        let vertex0 = g.getVertexByKey(token0);
        let vertex1 = g.getVertexByKey(token1);

        let metadata = { 
          dex: dex, 
          address: pool, 
          liquidity, 
          fee: Number(feeTier) / 1000000,
          feeTier: Number(feeTier)
        };

        updateOrAddEdge(g, vertex0, vertex1, -Math.log(price), price * (1 + SLIPPAGE + LENDING_FEE), metadata);
        updateOrAddEdge(g, vertex1, vertex0, -Math.log(1/price), (1/price) * (1 + SLIPPAGE + LENDING_FEE), metadata);
      } else {
        const { price, liquidity, token0, token1 } = await getSushiswapPoolData(pool);
        if (price === 0) continue;

        if (!g.getVertexByKey(token0)) {
          g.addVertex(new GraphVertex(token0));
        }
        if (!g.getVertexByKey(token1)) {
          g.addVertex(new GraphVertex(token1));
        }

        let vertex0 = g.getVertexByKey(token0);
        let vertex1 = g.getVertexByKey(token1);

        let metadata = { dex: dex, address: pool, liquidity, fee: 0.003 };

        updateOrAddEdge(g, vertex0, vertex1, -Math.log(price), price * (1 + SLIPPAGE + LENDING_FEE), metadata);
        updateOrAddEdge(g, vertex1, vertex0, -Math.log(1/price), (1/price) * (1 + SLIPPAGE + LENDING_FEE), metadata);
      }
    } catch (error) {
      console.error(`Error fetching pool ${pool} for ${dex}:`, error);
    }
  }
  console.log(`Finished processing ${pools.size} pools for ${dex}`);
}

function updateOrAddEdge(g: Graph, startVertex: GraphVertex, endVertex: GraphVertex, weight: number, rawWeight: number, metadata: EdgeMetadata): void {
  if (!startVertex || !endVertex) {
    console.warn(`Cannot add edge: one or both vertices do not exist`);
    return;
  }

  const existingEdge = g.findEdge(startVertex, endVertex);
  if (existingEdge) {
    if (weight < existingEdge.weight) {
      existingEdge.weight = weight;
      existingEdge.rawWeight = rawWeight;
      existingEdge.metadata = metadata;
    }
  } else {
    g.addEdge(new GraphEdge(startVertex, endVertex, weight, rawWeight, metadata));
  }
}

function calculatePathWeight(g: Graph, cycle: string[]): { cycleWeight: number, detailedCycle: any[] } {
  let cycleWeight = 1.0;
  let detailedCycle = [];

  for (let index = 0; index < cycle.length - 1; index++) {
    let indexNext = index + 1;
    let startVertex = g.getVertexByKey(cycle[index]);
    let endVertex = g.getVertexByKey(cycle[indexNext]);
    let edge = g.findEdge(startVertex, endVertex);

    cycleWeight *= edge.rawWeight * (1 + SLIPPAGE + LENDING_FEE);

    let transactionType = edge.rawWeight > 1 + SLIPPAGE + LENDING_FEE ? 'buy' : 'sell';
    let dexName = edge.metadata.dex === DEX.UniswapV3 ? "Uniswap V3" : "Sushiswap";

    detailedCycle.push({
      start: cycle[index],
      end: cycle[indexNext],
      type: transactionType,
      rawWeight: edge.rawWeight,
      dexnombre: dexName,
      dex: edge.metadata.dex, 
      poolAddress: edge.metadata.address,
      feeTier: edge.metadata.feeTier || 0
    });
  }
  return { cycleWeight, detailedCycle };
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
      let { cycleWeight, detailedCycle } = calculatePathWeight(g, cycle);
      if (!uniqueCycle[cycleString] && cycleWeight >= 1 + MINPROFIT) {
        uniqueCycle[cycleString] = true;
        let cycleType = cycleWeight > 1 ? 'buy' : 'sell';
        arbitrageData.push({
          cycle: cycle,
          cycleWeight: cycleWeight,
          detail: JSON.stringify(detailedCycle),
          type: cycleType
        });
      }
    }
  }
  console.log(`Arbitrage calculation complete. Found ${arbitrageData.length} opportunities.`);
  return arbitrageData;
}

async function calculateInitialAmounts(startToken: string): Promise<{ calculo1: string, montomaxflashloan: string }> {
  try {
    const pool = await findPoolForTokenPair(WMATIC_ADDRESS, startToken);
    if (!pool) {
      console.warn(`No se encontró una pool para WMATIC-${startToken}`);
      return { calculo1: '0', montomaxflashloan: '0' };
    }

    const { price } = await getUniswapV3PoolData(pool);
    if (price === 0) {
      console.warn("Price is zero, cannot calculate initial amounts");
      return { calculo1: '0', montomaxflashloan: '0' };
    }

    const calculo1 = JSBI.divide(
      JSBI.multiply(
        JSBI.BigInt(INITIAL_MATIC.toString()),
        JSBI.BigInt(Math.floor(price * 1e18))
      ),
      JSBI.BigInt(1e18)
    );
    const montomaxflashloan = JSBI.divide(
      JSBI.multiply(calculo1, JSBI.BigInt(1e18)),
      JSBI.BigInt(Math.floor(FLASH_LOAN_FEE * 1e18))
    );

    return { 
      calculo1: ethers.formatUnits(calculo1.toString(), 'gwei'),
      montomaxflashloan: ethers.formatUnits(montomaxflashloan.toString(), 'gwei')
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
  let currentAmount = JSBI.BigInt(ethers.parseUnits(amount, 'gwei').toString());
  const steps = JSON.parse(route.detail);

  for (const step of steps) {
    try {
      if (step.dex === DEX.UniswapV3) {
        const { price } = await getUniswapV3PoolData(step.poolAddress);
        if (step.type === "buy") {
          currentAmount = JSBI.divide(
            JSBI.multiply(currentAmount, JSBI.BigInt(1e18)),
            JSBI.BigInt(Math.floor(price * 1e18))
          );
        } else {
          currentAmount = JSBI.divide(
            JSBI.multiply(currentAmount, JSBI.BigInt(Math.floor(price * 1e18))),
            JSBI.BigInt(1e18)
          );
        }
      } else if (step.dex === DEX.Sushiswap) {
        const { price } = await getSushiswapPoolData(step.poolAddress);
        if (step.type === "buy") {
          currentAmount = JSBI.divide(
            JSBI.multiply(currentAmount, JSBI.BigInt(1e18)),
            JSBI.BigInt(Math.floor(price * 1e18))
          );
        } else {
          currentAmount = JSBI.divide(
            JSBI.multiply(currentAmount, JSBI.BigInt(Math.floor(price * 1e18))),
            JSBI.BigInt(1e18)
          );
        }
      }
    } catch (error) {
      console.error(`Error en el paso ${step.dex}:`, error);
      return '0';
    }
  }

  const initialAmount = JSBI.BigInt(ethers.parseUnits(amount, 'gwei').toString());
  const profit = JSBI.subtract(currentAmount, initialAmount);
  return ethers.formatUnits(profit.toString(), 'gwei');
}

async function processArbitrageRoutes(routes: ArbitrageRoute[]): Promise<ArbitrageRoute[]> {
  const processedRoutes: ArbitrageRoute[] = [];

  for (const route of routes) {
    try {
      const { calculo1, montomaxflashloan } = await calculateInitialAmounts(route.cycle[0]);
      const estimatedProfit = await calculateRouteProfit(route, montomaxflashloan);
      const isRentable = parseFloat(estimatedProfit) > 0;

      processedRoutes.push({
        ...route,
        calculo1,
        montomaxflashloan,
        estimatedProfit,
        isRentable
      });
    } catch (error) {
      console.error(`Error procesando ruta:`, error);
    }
  }

  return processedRoutes;
}

export async function main(numberTokens: number, dexs: Set<DEX>, debug: boolean = false){
  try {
    console.log("Iniciando el proceso de arbitraje...");

    const tokenIds = ALLOWED_TOKENS;
    console.log(`Se usarán ${tokenIds.length} tokens.`);

    let g: Graph = new Graph(true);
    tokenIds.forEach(id => g.addVertex(new GraphVertex(id)));
    console.log("Grafo inicializado.");

    console.log("Obteniendo pools y precios...");
    const uniPools = await fetchUniswapV3Pools(tokenIds);
    await fetchPoolPrices(g, uniPools, DEX.UniswapV3, true);
    const sushiPools = await fetchSushiswapPools(tokenIds);
    await fetchPoolPrices(g, sushiPools, DEX.Sushiswap, true);

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



//export { main };