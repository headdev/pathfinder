class Graph {
    edges: any[];
    vertices: Set<unknown>;
  
    constructor() {
      this.edges = [];
      this.vertices = new Set();
    }
  
    addEdge(startVertex, endVertex, weight) {
      this.edges.push({ startVertex, endVertex, weight });
      this.vertices.add(startVertex);
      this.vertices.add(endVertex);
    }
  
    getAllVertices() {
      return Array.from(this.vertices);
    }
  
    getAllEdges() {
      return this.edges;
    }
  }
  
  class GraphVertex {
    key: any;
    constructor(key) {
      this.key = key;
    }
  
    getKey() {
      return this.key;
    }
  }
  
  function bellmanFord(graph, startVertex) {
    const distances = {};
    const previousVertices = {};
  
    distances[startVertex.getKey()] = 0;
    graph.getAllVertices().forEach((vertex) => {
      previousVertices[vertex.getKey()] = null;
      if (vertex.getKey() !== startVertex.getKey()) {
        distances[vertex.getKey()] = Infinity;
      }
    });
  
    for (let iter = 0; iter < (graph.getAllVertices().length - 1); iter += 1) {
      let edges = graph.getAllEdges();
      for (let edge of edges) {
        let from = edge.startVertex;
        let to = edge.endVertex;
        if (distances[from.key] + edge.weight < distances[to.key]) {
          distances[to.key] = distances[from.key] + edge.weight;
          previousVertices[to.key] = from;
        }
      }
    }
  
    let edges = graph.getAllEdges();
    let cyclePaths = [];
    let foundCycles = {};
    for (let edge of edges) {
      let cyclePath = [];
      let from = edge.startVertex;
      let to = edge.endVertex;
      if (distances[from.key] + edge.weight < distances[to.key]) {
        let curr = from;
        let index = 1;
        cyclePath[to.key] = index++;
  
        while (!cyclePath[curr.key]) {
          cyclePath[curr.key] = index++;
          curr = previousVertices[curr.getKey()];
        }
        cyclePath[curr.key + '_'] = index;
  
        let path = [];
        for (let key of Object.keys(cyclePath)) { path.push(key.replace('_', '')); }
        path.reverse();
        for (var i = 0; i < path.length; i++) {
          if (i !== 0 && path[0] === path[i]) {
            path = path.slice(0, i + 1);
            break;
          }
        }
  
        let uniquePath = path.join('');
        if (!foundCycles[uniquePath]) {
          cyclePaths.push(path);
          foundCycles[uniquePath] = true;
        }
      }
    }
  
    const annotatedPaths = cyclePaths.map(path => {
      const transactions = [];
      for (let i = 0; i < path.length - 1; i++) {
        const from = path[i];
        const to = path[i + 1];
        const edge = graph.getAllEdges().find(e => e.startVertex.getKey() === from && e.endVertex.getKey() === to);
        if (edge) {
          transactions.push({
            action: edge.weight > 0 ? 'buy' : 'sell',
            from,
            to
          });
        }
      }
      return transactions;
    });
  
    return {
      distances,
      previousVertices,
      cyclePaths: annotatedPaths
    };
  }
  
  // Ejemplo de uso
  const graph = new Graph();
  
  const vertexA = new GraphVertex('Exchange A');
  const vertexB = new GraphVertex('Exchange B');
  const vertexC = new GraphVertex('Exchange C');
  
  graph.addEdge(vertexA, vertexB, Math.log(50)); // 1 BTC = 50 XYZ en A
  graph.addEdge(vertexB, vertexA, -Math.log(50));
  graph.addEdge(vertexA, vertexC, Math.log(55)); // 1 BTC = 55 XYZ en C
  graph.addEdge(vertexC, vertexA, -Math.log(55));
  graph.addEdge(vertexB, vertexC, Math.log(45)); // 1 BTC = 45 XYZ en B
  graph.addEdge(vertexC, vertexB, -Math.log(45));
  
  const startVertex = vertexA;
  const result = bellmanFord(graph, startVertex);
  
  console.log('Distances:', result.distances);
  console.log('Previous vertices:', result.previousVertices);
  console.log('Cycle paths (arbitrage opportunities):', result.cyclePaths);
  