const ccxt = require('ccxt');
const fs = require('fs');
const schedule = require('node-schedule');
import Graph from './graph_library/Graph';
import GraphVertex from './graph_library/GraphVertex';
import GraphEdge from './graph_library/GraphEdge';
const bellmanFord = require('./bellman-ford');

const binance = new ccxt.binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET_KEY',
});

const config = {
  allowedTokens: ['BTC', 'ETH', 'BNB', 'XRP', 'ADA'],
  minLiquidity: 100000,
  minProfitPercentage: 1,
  executionInterval: '*/5 * * * *', // Ejecutar cada 5 minutos
};

async function fetchTradingPairs() {
  try {
    const markets = await binance.fetchMarkets();
    const tradingPairs = markets
      .filter(market => market.quote === 'USDT' && config.allowedTokens.includes(market.base))
      .map(market => ({
        symbol: market.symbol,
        base: market.base,
        quote: market.quote,
      }));
    return tradingPairs;
  } catch (error) {
    console.error('Error al obtener los pares de trading:', error);
    return [];
  }
}

async function fetchOrderBookLiquidity(tradingPairs) {
  const liquidityMap = {};
  for (const pair of tradingPairs) {
    try {
      const orderBook = await binance.fetchOrderBook(pair.symbol, 5);
      const bestBidLiquidity = orderBook.bids.reduce((sum, bid) => sum + bid[0] * bid[1], 0);
      const bestAskLiquidity = orderBook.asks.reduce((sum, ask) => sum + ask[0] * ask[1], 0);
      const liquidity = Math.min(bestBidLiquidity, bestAskLiquidity);
      liquidityMap[pair.symbol] = liquidity;
    } catch (error) {
      console.error(`Error al obtener el order book para el par ${pair.symbol}:`, error);
    }
  }
  return liquidityMap;
}

function buildGraph(tradingPairs, liquidityMap) {
  const graph = new Graph(true);

  const usdtVertex = new GraphVertex('USDT');
  graph.addVertex(usdtVertex);

  for (const pair of tradingPairs) {
    if (liquidityMap[pair.symbol] >= config.minLiquidity) {
      const baseVertex = new GraphVertex(pair.base);
      graph.addVertex(baseVertex);

      const price = liquidityMap[pair.symbol] / config.minLiquidity;
      const weight = -Math.log(price);
      graph.addEdge(new GraphEdge(usdtVertex, baseVertex, weight));
      graph.addEdge(new GraphEdge(baseVertex, usdtVertex, -weight));
    }
  }

  return graph;
}

function findArbitrageOpportunities(graph, startVertex) {
  const result = bellmanFord(graph, startVertex);
  const opportunities = result.cyclePaths
    .filter(path => path[0] === 'USDT' && path[path.length - 1] === 'USDT')
    .map(path => ({
      path: path,
      profit: Math.exp(-path.reduce((sum, vertex) => {
        const edge = graph.findEdge(graph.getVertexByKey(vertex), graph.getVertexByKey(path[path.indexOf(vertex) + 1]));
        return sum + edge.weight;
      }, 0)),
    }))
    .filter(opportunity => opportunity.profit > 1 + config.minProfitPercentage / 100);
  return opportunities;
}

function saveOpportunitiesToJson(opportunities) {
  const jsonData = JSON.stringify(opportunities, null, 2);
  fs.writeFileSync('arbitrage_opportunities.json', jsonData);
}

async function main() {
  try {
    const tradingPairs = await fetchTradingPairs();
    const liquidityMap = await fetchOrderBookLiquidity(tradingPairs);
    const graph = buildGraph(tradingPairs, liquidityMap);
    const startVertex = graph.getVertexByKey('USDT');
    const opportunities = findArbitrageOpportunities(graph, startVertex);

    console.log('Oportunidades de arbitraje encontradas:');
    opportunities.forEach(opportunity => {
      console.log(`Ruta: ${opportunity.path.join(' -> ')}`);
      console.log(`Beneficio: ${(opportunity.profit - 1) * 100}%`);
      console.log('---');
    });

    if (opportunities.length > 0) {
      saveOpportunitiesToJson(opportunities);
      console.log('Las oportunidades de arbitraje se han guardado en arbitrage_opportunities.json');
      // Aquí puedes agregar la lógica para enviar notificaciones sobre las oportunidades encontradas
    } else {
      console.log('No se encontraron oportunidades de arbitraje.');
    }
  } catch (error) {
    console.error('Error en la ejecución del bot:', error);
  }
}

// Programar la ejecución del bot según el intervalo especificado en la configuración
schedule.scheduleJob(config.executionInterval, main);