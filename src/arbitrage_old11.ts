    import { ethers } from 'ethers';
    import { request } from 'graphql-request';
    import * as fs from 'fs';
    import * as path from 'path';
    import dotenv from 'dotenv';

    import Graph from './graph_library/Graph';
    import GraphVertex from './graph_library/GraphVertex';
    import GraphEdge, { EdgeMetadata } from './graph_library/GraphEdge';
    import * as UNISWAP from './dex_queries/uniswap';
    import * as SUSHISWAP from './dex_queries/sushiswap';
    import { 
      DEX, 
      MIN_TVL, 
      MINPROFIT, 
      FEE_TEIR_PERCENTAGE_OBJECT
    } from './constants';

    dotenv.config();

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

    const SLIPPAGE = 0.0005; // 0.05% de slippage por trade
    const FLASH_LOAN_FEE = 0.0009; // 0.09% de fee para el préstamo flash (este valor puede variar según el proveedor)

    const ORIGIN_TOKENS = [
      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
      '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', // WBTC
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", //USDT
      // Agrega aquí más tokens que quieras usar como origen
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

    const uniswapV3Factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
    const sushiswapFactory = new ethers.Contract(SUSHISWAP_FACTORY_ADDRESS, SUSHISWAP_FACTORY_ABI, provider);

    interface SwapStep {
      fromToken: string;
      toToken: string;
      dex: DEX | string;
    }
    
    interface ArbitrageRoute {
      cycle: string[];
      cycleWeight: number;
      steps: SwapStep[];
      type: 'cyclic' | 'non-cyclic';
    }


    async function fetchTokens(first: number, skip: number = 0, dex: DEX): Promise<string[]> {
      let dexEndpoint = (dex === DEX.UniswapV3) ? UNISWAP.ENDPOINT : SUSHISWAP.ENDPOINT;
      let tokensQuery = (dex === DEX.UniswapV3) ? UNISWAP.HIGHEST_VOLUME_TOKENS(first) : SUSHISWAP.HIGHEST_VOLUME_TOKENS(first, skip);
      
      try {
        let mostActiveTokens = await request(dexEndpoint, tokensQuery);
        console.log(`Tokens from ${dex}:`, mostActiveTokens.tokens)

        return mostActiveTokens.tokens.map((t: any) => t.id);
      } catch (error) {
        console.error(`Error fetching tokens from ${dex}:`, error);
        return [];
      }
    }

    async function fetchUniswapV3Pools(tokenIds: string[], maxPools: number = 50): Promise<Set<string>> {
      const pools = new Set<string>();
      const fees = [500, 3000, 10000];

      for (let i = 0; i < tokenIds.length && pools.size < maxPools; i++) {
        for (let j = i + 1; j < tokenIds.length && pools.size < maxPools; j++) {
          for (const fee of fees) {
            if (pools.size >= maxPools) break;
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

    async function fetchSushiswapPools(tokenIds: string[], maxPools: number = 50): Promise<Set<string>> {
      const pools = new Set<string>();

      for (let i = 0; i < tokenIds.length && pools.size < maxPools; i++) {
        for (let j = i + 1; j < tokenIds.length && pools.size < maxPools; j++) {
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
        const liquidity = (BigInt(reserve0.toString()) + BigInt(reserve1.toString())).toString();

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
    
    function getDexName(dex: DEX): string {
      switch (dex) {
        case DEX.UniswapV3:
          return "UniswapV3";
        case DEX.Sushiswap:
          return "Sushiswap";
        default:
          return "Unknown";
      }
    }


    function detectNonCyclicArbitrage(graph: Graph, sourceToken: string, targetToken: string): ArbitrageRoute | null {
      const lineGraph = createLineGraph(graph);
      
      const sourceVertices = lineGraph.getAllVertices().filter(v => v.getKey().startsWith(sourceToken + '-'));
      
      if (sourceVertices.length === 0) {
        return null;
      }
      
      let bestArbitrage: ArbitrageRoute | null = null;
      
      for (const sourceVertex of sourceVertices) {
        const { distances, paths } = modifiedMooreBellmanFord(lineGraph, sourceVertex);
        
        const targetVertices = lineGraph.getAllVertices().filter(v => v.getKey().endsWith('-' + targetToken));
        
        for (const targetVertex of targetVertices) {
          if (distances[targetVertex.getKey()] < 0) {
            const arbitragePath = paths[targetVertex.getKey()].map(vertex => vertex.split('-')[0]);
            const steps: SwapStep[] = arbitragePath.map((token, index) => {
              if (index === arbitragePath.length - 1) return { fromToken: token, toToken: sourceToken, dex: DEX.UniswapV3 };
              const nextToken = arbitragePath[index + 1];
              const edge = graph.findEdge(graph.getVertexByKey(token), graph.getVertexByKey(nextToken));
              return {
                fromToken: token,
                toToken: nextToken,
                dex: edge ? edge.metadata.dex : DEX.UniswapV3
              };
            });
            const arbitrage: ArbitrageRoute = {
              cycle: [sourceToken, ...arbitragePath, sourceToken],
              cycleWeight: Math.exp(-distances[targetVertex.getKey()]),
              steps: steps,
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


    /*/ async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
      console.log("Starting arbitrage calculation...");
      let arbitrageData: ArbitrageRoute[] = [];
      let uniqueCycle: {[key: string]: boolean} = {};

      for (const startVertex of g.getAllVertices()) {
        console.log(`Calculating for vertex: ${startVertex.getKey()}`);
        let cycles = findCycles(g, startVertex, 3, 6);
        
        for (const cycle of cycles) {
          let cycleString = cycle.join('');
          if (!uniqueCycle[cycleString]) {
            uniqueCycle[cycleString] = true;
            let { weight: cycleWeight, dexPath } = calculateCycleWeight(g, cycle);
            
            // Verificar si la ruta incluye tanto Uniswap V3 como Sushiswap
            const hasUniswap = dexPath.includes(DEX.UniswapV3);
            const hasSushiswap = dexPath.includes(DEX.Sushiswap);
            
            if (cycleWeight > 1.001 && cycleWeight < 1.5 && hasUniswap && hasSushiswap) {
              const detail = cycle.map((token, index) => {
                if (index === cycle.length - 1) return token;
                return `${token} (${DEX[dexPath[index]]})`;
              }).join(' -> ');

              arbitrageData.push({
                cycle: cycle,
                cycleWeight: cycleWeight,
                detail: detail,
                type: 'cyclic',
                dexPath: dexPath
              });
            }
          }
        }
      }

      console.log(`Arbitrage calculation complete. Found ${arbitrageData.length} opportunities.`);
      return arbitrageData;
    } /*/

    /*/ async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
      console.log("Starting arbitrage calculation...");
      let arbitrageData: ArbitrageRoute[] = [];
      let uniqueCycle: {[key: string]: boolean} = {};

      for (const originToken of ORIGIN_TOKENS) {
        const startVertex = g.getVertexByKey(originToken);
        if (!startVertex) {
          console.log(`Origin token ${originToken} not found in graph. Skipping...`);
          continue;
        }

        console.log(`Calculating for vertex: ${startVertex.getKey()}`);
        let cycles = findCycles(g, startVertex, 3, 6);
        
        for (const cycle of cycles) {
          let cycleString = cycle.join('');
          if (!uniqueCycle[cycleString]) {
            uniqueCycle[cycleString] = true;
            let { weight: cycleWeight, dexPath } = calculateCycleWeight(g, cycle);
            
            // Verificar si la ruta incluye tanto Uniswap V3 como Sushiswap
            const hasUniswap = dexPath.includes(DEX.UniswapV3);
            const hasSushiswap = dexPath.includes(DEX.Sushiswap);
            
            if (cycleWeight > 1.01 && cycleWeight < 1.5 && hasUniswap && hasSushiswap) {
              const detail = cycle.map((token, index) => {
                if (index === cycle.length - 1) return token;
                return `${token} (${DEX[dexPath[index]]})`;
              }).join(' -> ');

              arbitrageData.push({
                cycle: cycle,
                cycleWeight: cycleWeight,
                detail: detail,
                type: 'cyclic',
                dexPath: dexPath
              });
            }
          }
        }
      }

      console.log(`Arbitrage calculation complete. Found ${arbitrageData.length} opportunities.`);
      return arbitrageData;
    } /*/

    async function calcArbitrage(g: Graph): Promise<ArbitrageRoute[]> {
      console.log("Starting arbitrage calculation...");
      let arbitrageData: ArbitrageRoute[] = [];
      let uniqueCycle: {[key: string]: boolean} = {};
    
      // Calcular rutas cíclicas
      for (const originToken of ORIGIN_TOKENS) {
        const startVertex = g.getVertexByKey(originToken);
        if (!startVertex) {
          console.log(`Origin token ${originToken} not found in graph. Skipping...`);
          continue;
        }
    
        console.log(`Calculating for vertex: ${startVertex.getKey()}`);
        let cycles = findCycles(g, startVertex, 3, 6);
        
        for (const cycle of cycles) {
          let cycleString = cycle.join('');
          if (!uniqueCycle[cycleString]) {
            uniqueCycle[cycleString] = true;
            let { weight: cycleWeight, steps } = calculateCycleWeight(g, cycle);
            
            // Verificar si la ruta incluye tanto Uniswap V3 como Sushiswap
            const hasUniswap = steps.some(step => step.dex === DEX.UniswapV3);
            const hasSushiswap = steps.some(step => step.dex === DEX.Sushiswap);
            
            if (cycleWeight > 1.015 && cycleWeight < 1.5 && hasUniswap && hasSushiswap) {
              arbitrageData.push({
                cycle: cycle,
                cycleWeight: cycleWeight,
                steps: steps,
                type: 'cyclic'
              });
            }
          }
        }
      }
    
      // Calcular rutas no cíclicas
      for (const sourceToken of ORIGIN_TOKENS) {
        for (const targetToken of ORIGIN_TOKENS) {
          if (sourceToken !== targetToken) {
            const nonCyclicArbitrage = detectNonCyclicArbitrage(g, sourceToken, targetToken);
            if (nonCyclicArbitrage && nonCyclicArbitrage.cycleWeight > 1.015 && nonCyclicArbitrage.cycleWeight < 1.5) {
              arbitrageData.push(nonCyclicArbitrage);
            }
          }
        }
      }
    
      // Procesar los datos de arbitraje para reemplazar los números de DEX por nombres
      const processedArbitrageData = arbitrageData.map(route => ({
        ...route,
        steps: route.steps.map(step => ({
          ...step,
          dex: getDexName(step.dex as DEX)
        }))
      }));
    
      console.log(`Arbitrage calculation complete. Found ${processedArbitrageData.length} opportunities.`);
      return processedArbitrageData;
    }


    function findCycles(g: Graph, startVertex: GraphVertex, minLength: number, maxLength: number): string[][] {
      let cycles: string[][] = [];
      let path: string[] = [startVertex.getKey()];
      let visited: {[key: string]: boolean} = {};

      function dfs(currentVertex: GraphVertex, depth: number) {
        if (depth > maxLength) return;

        visited[currentVertex.getKey()] = true;

        const edges = g.getAllEdges().filter(edge => edge.startVertex.getKey() === currentVertex.getKey());

        for (const edge of edges) {
          const nextVertex = edge.endVertex;
          
          if (nextVertex.getKey() === startVertex.getKey() && depth >= minLength) {
            cycles.push([...path, startVertex.getKey()]); // Añadimos el token inicial al final para cerrar el ciclo
          } else if (!visited[nextVertex.getKey()] && depth < maxLength - 1) {
            path.push(nextVertex.getKey());
            dfs(nextVertex, depth + 1);
            path.pop();
          }
        }

        visited[currentVertex.getKey()] = false;
      }

      dfs(startVertex, 0);
      return cycles;
    }

    /*/ function calculateCycleWeight(g: Graph, cycle: string[]): { weight: number, dexPath: DEX[] } {
      let logWeight = 0;
      let dexPath: DEX[] = [];
      for (let i = 0; i < cycle.length - 1; i++) {
        const edge = g.findEdge(g.getVertexByKey(cycle[i]), g.getVertexByKey(cycle[i + 1]));
        if (edge) {
          logWeight += edge.weight - Math.log(1 - edge.metadata.fee);
          dexPath.push(edge.metadata.dex);
        } else {
          console.warn(`No edge found between ${cycle[i]} and ${cycle[i + 1]}`);
          return { weight: 0, dexPath: [] };
        }
      }
      return { weight: Math.exp(-logWeight), dexPath };
    } / */ //calculos sin slippage ni flashloanfee

    function calculateCycleWeight(g: Graph, cycle: string[]): { weight: number, steps: SwapStep[] } {
      let logWeight = 0;
      let steps: SwapStep[] = [];
      for (let i = 0; i < cycle.length - 1; i++) {
        const edge = g.findEdge(g.getVertexByKey(cycle[i]), g.getVertexByKey(cycle[i + 1]));
        if (edge) {
          logWeight += edge.weight - Math.log(1 - edge.metadata.fee - SLIPPAGE);
          steps.push({
            fromToken: cycle[i],
            toToken: cycle[i + 1],
            dex: edge.metadata.dex
          });
        } else {
          console.warn(`No edge found between ${cycle[i]} and ${cycle[i + 1]}`);
          return { weight: 0, steps: [] };
        }
      }
      
      logWeight -= Math.log(1 - FLASH_LOAN_FEE);
      
      return { weight: Math.exp(-logWeight), steps };
    }
    
    async function main(numberTokens: number = 5, DEXs: Set<DEX>, debug: boolean = false) {
      try {
        console.log("Iniciando el proceso de arbitraje...");

        let uniTokens = DEXs.has(DEX.UniswapV3) ? await fetchTokens(numberTokens, 0, DEX.UniswapV3) : [];
        let sushiTokens = DEXs.has(DEX.Sushiswap) ? await fetchTokens(numberTokens, 0, DEX.Sushiswap) : [];
        
        // let tokenIds = [...new Set([...uniTokens, ...sushiTokens])]; // no incluye los origin tokens 
        let tokenIds = [...new Set([...uniTokens, ...sushiTokens, ...ORIGIN_TOKENS])];

        console.log(`Total tokens: ${tokenIds.length}`);

        let g: Graph = new Graph(true);
        tokenIds.forEach(element => {
          g.addVertex(new GraphVertex(element))
        });

        console.log("Obteniendo pools y precios...");
        let uniPools: Set<string> | undefined;
        let sushiPools: Set<string> | undefined;

        if (DEXs.has(DEX.UniswapV3)) {
          uniPools = await fetchUniswapV3Pools(uniTokens, 50);
          console.log(`Uniswap V3 pools found: ${uniPools.size}`);
          await fetchPoolPrices(g, uniPools, DEX.UniswapV3, debug);
        }
        if (DEXs.has(DEX.Sushiswap)) {
          sushiPools = await fetchSushiswapPools(sushiTokens, 50);
          console.log(`Sushiswap pools found: ${sushiPools.size}`);
          await fetchPoolPrices(g, sushiPools, DEX.Sushiswap, debug);
        }

        console.log(`Total pools: ${(uniPools?.size || 0) + (sushiPools?.size || 0)}`);

        console.log("Calculando rutas de arbitraje...");
        const arbitrageRoutes = await calcArbitrage(g);
        console.log(`Se encontraron ${arbitrageRoutes.length} rutas de arbitraje potenciales.`);

        const filePath = path.join(__dirname, 'arbitrageRoutes.json');
        fs.writeFileSync(filePath, JSON.stringify(arbitrageRoutes, null, 2));
        console.log(`Resultados guardados en ${filePath}`);

        console.log(`Proceso completado. Se encontraron ${arbitrageRoutes.length} rutas de arbitraje.`);
      } catch (error) {
        console.error("Error en la ejecución principal:", error);
      }
    }

    // Si quieres ejecutar el script directamente
    if (require.main === module) {
      main(10, new Set([DEX.UniswapV3, DEX.Sushiswap]), true)
        .then(() => console.log("Script completed successfully"))
        .catch(error => console.error("An error occurred during execution:", error));
    }

    export { main };