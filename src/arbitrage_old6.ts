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

dotenv.config();

const INITIAL_MATIC = ethers.parseUnits('100', 'gwei');
const FLASH_LOAN_FEE = new BigNumber(0.0005); // 0.05% as 5 basis points
const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const MIN_PROFITABLE_AMOUNT = new BigNumber(0.0001);

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

const provider = new ethers.JsonRpcProvider("https://bold-black-road.matic.quiknode.pro/256dc2c56afd0b5bc32d7c424c3b8c67eb93ad40");

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
}

async function fetchUniswapV3Pools(tokenIds: string[]): Promise<Set<string>> {
  const pools = new Set<string>();
  const fees = [500, 3000, 10000];

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

async function getUniswapV3PoolData(poolAddress: string): Promise<{ price: BigNumber, liquidity: BigNumber, token0: string, token1: string, feeTier: BigNumber }> {
  const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);

  try {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    const [sqrtPriceX96, , , , , ] = await poolContract.slot0();
    const liquidity = await poolContract.liquidity();
    const feeTier = await poolContract.fee();

    const price = new BigNumber(sqrtPriceX96.toString()).dividedBy(2 ** 96).pow(2);

    if (price.isZero()) {
      console.warn(`Price is zero for pool ${poolAddress}`);
      return { price: new BigNumber(0), liquidity: new BigNumber(0), token0, token1, feeTier: new BigNumber(0) };
    }

    return {
      price,
      liquidity: new BigNumber(liquidity.toString()),
      token0,
      token1,
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

    const price = new BigNumber(reserve1.toString()).dividedBy(reserve0.toString());
    const liquidity = new BigNumber(reserve0.toString()).plus(reserve1.toString());

    if (price.isZero()) {
      console.warn(`Price is zero for pool ${poolAddress}`);
      return { price: new BigNumber(0), liquidity: new BigNumber(0), token0, token1 };
    }

    return { price, liquidity, token0, token1 };
  } catch (error) {
    console.error(`Error al obtener datos de la pool de Sushiswap ${poolAddress}:`, error);
    return { price: new BigNumber(0), liquidity: new BigNumber(0), token0: '', token1: '' };
  }
}

async function fetchPoolPrices(g: Graph, pools: Set<string>, dex: DEX, debug: boolean = false): Promise<void> {
  const MIN_PRICE = new BigNumber('1e-18'); // Un precio mínimo muy pequeño

  if (debug) console.log(pools);
  for (var pool of Array.from(pools.values())) {
    try {
      if (debug) console.log(dex, pool);

      let poolData;
      try {
        poolData = dex === DEX.UniswapV3 ? await getUniswapV3PoolData(pool) : await getSushiswapPoolData(pool);
      } catch (error) {
        console.error(`Error fetching pool ${pool} for ${dex}:`, error);
        continue;
      }

      const { price, liquidity, token0, token1, feeTier } = poolData;

      // Asegurarse de que price es un BigNumber
      const bnPrice = BigNumber.isBigNumber(price) ? price : new BigNumber(price.toString());

      if (bnPrice.isLessThan(MIN_PRICE)) {
        console.warn(`Price is below threshold for pool ${pool}`);
        continue;
      }

      if (!g.getVertexByKey(token0)) {
        g.addVertex(new GraphVertex(token0));
      }
      if (!g.getVertexByKey(token1)) {
        g.addVertex(new GraphVertex(token1));
      }

      let vertex0 = g.getVertexByKey(token0);
      let vertex1 = g.getVertexByKey(token1);

      let metadata: EdgeMetadata = dex === DEX.UniswapV3
        ? {
            dex: dex,
            address: pool,
            liquidity: liquidity.toString(),
            fee: BigNumber.isBigNumber(feeTier) ? feeTier.dividedBy(1000000).toNumber() : Number(feeTier) / 1000000,
            feeTier: BigNumber.isBigNumber(feeTier) ? feeTier.toNumber() : Number(feeTier)
          }
        : { dex: dex, address: pool, liquidity: liquidity.toString(), fee: 0.003 };

      // Usar Math.log() para calcular el logaritmo natural
      const logPrice = Math.log(bnPrice.toNumber());
      updateOrAddEdge(g, vertex0, vertex1, -logPrice, bnPrice, metadata);
      updateOrAddEdge(g, vertex1, vertex0, logPrice, new BigNumber(1).dividedBy(bnPrice), metadata);
    } catch (error) {
      console.error(`Error fetching pool ${pool} for ${dex}:`, error);
    }
  }
  console.log(`Finished processing ${pools.size} pools for ${dex}`);
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
      existingEdge.rawWeight = rawWeight.toNumber();
      existingEdge.metadata = metadata;
    }
  } else {
    g.addEdge(new GraphEdge(startVertex, endVertex, weight, rawWeight.toNumber(), metadata));
  }
}

function calculatePathWeight(g: Graph, cycle: string[]): { cycleWeight: BigNumber, detailedCycle: any[] } {
  let cycleWeight = new BigNumber(1);
  let detailedCycle = [];

  for (let index = 0; index < cycle.length - 1; index++) {
    let indexNext = index + 1;
    let startVertex = g.getVertexByKey(cycle[index]);
    let endVertex = g.getVertexByKey(cycle[indexNext]);
    let edge = g.findEdge(startVertex, endVertex);

    const fee = new BigNumber(edge.metadata.fee);
    const rawWeight = new BigNumber(edge.rawWeight);
    
    // Incluir la tarifa en el cálculo del peso del ciclo
    cycleWeight = cycleWeight.times(rawWeight).times(new BigNumber(1).minus(fee));

    let transactionType = rawWeight.isGreaterThan(1) ? 'buy' : 'sell';
    let dexName = edge.metadata.dex === DEX.UniswapV3 ? "Uniswap V3" : "Sushiswap";

    detailedCycle.push({
      start: cycle[index],
      end: cycle[indexNext],
      type: transactionType,
      rawWeight: rawWeight.toString(),
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
      if (!uniqueCycle[cycleString] && cycleWeight.isGreaterThan(new BigNumber(1).plus(MINPROFIT))) {
        uniqueCycle[cycleString] = true;
        let cycleType = cycleWeight.isGreaterThan(1) ? 'buy' : 'sell';
        arbitrageData.push({
          cycle: cycle,
          cycleWeight: cycleWeight.toString(),
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
    if (price.isZero()) {
      console.warn("Price is zero, cannot calculate initial amounts");
      return { calculo1: '0', montomaxflashloan: '0' };
    }

    // Convertir 100 MATIC al token de inicio
    const calculo1 = new BigNumber(INITIAL_MATIC.toString()).times(price).div(1e18);
    
    // Calcular el monto máximo a prestar considerando el FLASH_LOAN_FEE
    const montomaxflashloan = calculo1.div(new BigNumber(1).minus(FLASH_LOAN_FEE));

    return {
      calculo1: calculo1.toString(),
      montomaxflashloan: montomaxflashloan.toString()
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
      let price = new BigNumber(step.rawWeight);
      let fee = new BigNumber(step.feeTier).dividedBy(1000000);

      if (step.type === "buy") {
        currentAmount = currentAmount.times(new BigNumber(1).minus(fee)).dividedBy(price);
      } else {
        currentAmount = currentAmount.times(price).times(new BigNumber(1).minus(fee));
      }
    } catch (error) {
      console.error(`Error en el paso ${step.dex}:`, error);
      return '0';
    }
  }

  const initialAmount = new BigNumber(amount);
  const profit = currentAmount.minus(initialAmount);
  
  // Solo considerar el FLASH_LOAN_FEE, ya que es el mismo que LENDING_FEE
  const totalFee = initialAmount.times(FLASH_LOAN_FEE);
  const netProfit = profit.minus(totalFee);

  

  return netProfit.toString();
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
      const isRentable = new BigNumber(estimatedProfit).isGreaterThan(MIN_PROFITABLE_AMOUNT);

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

async function main(numberTokens: number = 5, DEXs: Set<DEX>, debug: boolean = false) {
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

// Si quieres ejecutar el script directamente
if (require.main === module) {
  main(5, new Set([DEX.UniswapV3, DEX.Sushiswap]), true)
    .then(() => console.log("Script completed successfully"))
    .catch(error => console.error("An error occurred during execution:", error));
}