import { ethers } from 'ethers';
import JSBI from 'jsbi';
import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge, { EdgeMetadata } from './graph_library/GraphEdge';
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
  cycleWeight: number;
  detail: string;
  type: string;
  calculo1?: string;
  montomaxflashloan?: string;
  estimatedProfit?: string;
  estimatedProfitWithFees?: string;
  isRentable?: boolean;
}

function createLineGraph(originalGraph: Graph): Graph {
  const lineGraph = new Graph(true);
  
  for (const edge of originalGraph.getAllEdges()) {
    lineGraph.addVertex(new GraphVertex(`${edge.startVertex.getKey()}-${edge.endVertex.getKey()}`));
  }
  
  for (const edge1 of originalGraph.getAllEdges()) {
    for (const edge2 of originalGraph.getAllEdges()) {
      if (edge1.endVertex === edge2.startVertex) {
        const vertex1 = lineGraph.getVertexByKey(`${edge1.startVertex.getKey()}-${edge1.endVertex.getKey()}`);
        const vertex2 = lineGraph.getVertexByKey(`${edge2.startVertex.getKey()}-${edge2.endVertex.getKey()}`);
        lineGraph.addEdge(new GraphEdge(
          vertex1,
          vertex2,
          edge2.weight,
          edge2.rawWeight,
          edge2.metadata
        ));
      }
    }
  }
  
  return lineGraph;
}

function modifiedMooreBellmanFord(graph: Graph, sourceVertex: GraphVertex): { distances: {[key: string]: number}, paths: {[key: string]: string[]} } {
  const distances: {[key: string]: number} = {};
  const paths: {[key: string]: string[]} = {};
  
  for (const vertex of graph.getAllVertices()) {
    distances[vertex.getKey()] = Infinity;
    paths[vertex.getKey()] = [];
  }
  
  if (!sourceVertex) {
    console.warn("Source vertex is undefined");
    return { distances, paths };
  }
  
  distances[sourceVertex.getKey()] = 0;
  
  for (let i = 0; i < graph.getAllVertices().length - 1; i++) {
    for (const edge of graph.getAllEdges()) {
      if (!edge.startVertex || !edge.endVertex) continue;
      
      const startDistance = distances[edge.startVertex.getKey()];
      const endDistance = distances[edge.endVertex.getKey()];
      
      if (startDistance + edge.weight < endDistance) {
        distances[edge.endVertex.getKey()] = startDistance + edge.weight;
        paths[edge.endVertex.getKey()] = [...paths[edge.startVertex.getKey()], edge.endVertex.getKey()];
        
        if (!paths[edge.startVertex.getKey()].includes(edge.endVertex.getKey()) || edge.endVertex.getKey() === sourceVertex.getKey()) {
          distances[edge.endVertex.getKey()] = startDistance + edge.weight;
          paths[edge.endVertex.getKey()] = [...paths[edge.startVertex.getKey()], edge.endVertex.getKey()];
        }
      }
    }
  }
  
  return { distances, paths };
}

function detectNonCyclicArbitrage(graph: Graph, sourceToken: string, targetToken: string): ArbitrageRoute | null {
  const lineGraph = createLineGraph(graph);
  
  // Buscar todos los vértices que comienzan con sourceToken
  const sourceVertices = lineGraph.getAllVertices().filter(v => v.getKey().startsWith(sourceToken + '-'));
  
  if (sourceVertices.length === 0) {
    return null;  // No hay vértices que comiencen con sourceToken
  }
  
  let bestArbitrage: ArbitrageRoute | null = null;
  
  for (const sourceVertex of sourceVertices) {
    const { distances, paths } = modifiedMooreBellmanFord(lineGraph, sourceVertex);
    
    // Buscar todos los vértices que terminan con targetToken
    const targetVertices = lineGraph.getAllVertices().filter(v => v.getKey().endsWith('-' + targetToken));
    
    for (const targetVertex of targetVertices) {
      if (distances[targetVertex.getKey()] < 0) {
        const arbitragePath = paths[targetVertex.getKey()].map(vertex => vertex.split('-')[0]);
        const arbitrage: ArbitrageRoute = {
          cycle: [sourceToken, ...arbitragePath, sourceToken],
          cycleWeight: Math.exp(-distances[targetVertex.getKey()]),
          detail: JSON.stringify(arbitragePath),
          type: 'non-cyclic'
        };
        
        if (!bestArbitrage || arbitrage.cycleWeight > bestArbitrage.cycleWeight) {
          bestArbitrage = arbitrage;
        }
      }
    }
  }
  
  return bestArbitrage;
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
    const liquidity = JSBI.add(
      JSBI.BigInt(reserve0.toString()),
      JSBI.BigInt(reserve1.toString())
    ).toString();

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

        updateOrAddEdge(g, vertex0, vertex1, -Math.log(price), price, metadata);
        updateOrAddEdge(g, vertex1, vertex0, -Math.log(1/price), 1/price, metadata);
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

        updateOrAddEdge(g, vertex0, vertex1, -Math.log(price), price, metadata);
        updateOrAddEdge(g, vertex1, vertex0, -Math.log(1/price), 1/price, metadata);
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

async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
  console.log("Starting arbitrage calculation...");
  let arbitrageData: ArbitrageRoute[] = [];
  let uniqueCycle: {[key: string]: boolean} = {};

  // Detección de arbitraje cíclico
  for (const vertex of g.getAllVertices()) {
    console.log(`Calculating for vertex: ${vertex.getKey()}`);
    let result = modifiedMooreBellmanFord(g, vertex);
    let cyclePaths = result.paths;
    console.log(`Found ${Object.keys(cyclePaths).length} potential paths for vertex ${vertex.getKey()}`);
    for (const [endVertex, path] of Object.entries(cyclePaths)) {
      if (path.length >= 3 && path.length <= 10 && path[0] === vertex.getKey() && path[path.length - 1] === vertex.getKey()) {
        let cycleString = path.join('');
        if (!uniqueCycle[cycleString]) {
          uniqueCycle[cycleString] = true;
          let cycleWeight = Math.exp(-result.distances[endVertex]);
          if (cycleWeight > 1 + MINPROFIT) {
            arbitrageData.push({
              cycle: path,
              cycleWeight: cycleWeight,
              detail: JSON.stringify(path),
              type: 'cyclic'
            });
          }
        }
      }
    }
  }

  // Detección de arbitraje no cíclico
  for (const sourceVertex of g.getAllVertices()) {
    for (const targetVertex of g.getAllVertices()) {
      if (sourceVertex !== targetVertex) {
        const nonCyclicArbitrage = detectNonCyclicArbitrage(g, sourceVertex.getKey(), targetVertex.getKey());
        if (nonCyclicArbitrage) {
          arbitrageData.push(nonCyclicArbitrage);
        }
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
    
    // El montomaxflashloan ya incluye el fee de AAVE
    const montomaxflashloan = JSBI.divide(
      JSBI.multiply(calculo1, JSBI.BigInt(10000)),
      JSBI.BigInt(9995)  // 10000 / (1 - 0.0005) = 10000 / 0.9995 ≈ 10005
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

function calculateOptimalInput(route: ArbitrageRoute, minInput: number, maxInput: number): number {
  const tolerance = 0.0001;
  let low = minInput;
  let high = maxInput;

  while (high - low > tolerance) {
    const mid = (low + high) / 2;
    const profit = calculateProfit(route, mid);
    const profitPlus = calculateProfit(route, mid + tolerance);

    if (profitPlus > profit) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

function calculateProfit(route: ArbitrageRoute, input: number): number {
  let currentAmount = input;
  const steps = JSON.parse(route.detail);

  for (const step of steps) {
    const fee = step.dex === DEX.UniswapV3 ? step.feeTier / 1000000 : 0.003;
    currentAmount = currentAmount * (1 - fee) * step.rawWeight;
  }

  return currentAmount - input;
}

async function processArbitrageRoutes(routes: ArbitrageRoute[]): Promise<ArbitrageRoute[]> {
  const processedRoutes: ArbitrageRoute[] = [];

  for (const route of routes) {
    try {
      const { calculo1, montomaxflashloan } = await calculateInitialAmounts(route.cycle[0]);
      if (calculo1 === '0' || montomaxflashloan === '0') {
        continue;  // Skip this route if we couldn't calculate initial amounts
      }
      const optimalInput = calculateOptimalInput(route, parseFloat(calculo1), parseFloat(montomaxflashloan));
      const estimatedProfit = calculateProfit(route, optimalInput).toString();
      const estimatedProfitWithFees = (parseFloat(estimatedProfit) - parseFloat(montomaxflashloan) * LENDING_FEE).toString();
      const isRentable = parseFloat(estimatedProfitWithFees) > 0;

      processedRoutes.push({
        ...route,
        calculo1,
        montomaxflashloan,
        estimatedProfit,
        estimatedProfitWithFees,
        isRentable
      });
    } catch (error) {
      console.error(`Error procesando ruta:`, error);
    }
  }

  return processedRoutes;
}

export async function main(numberTokens: number, dexs: Set<DEX>, debug: boolean = false) {
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