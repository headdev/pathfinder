import Graph from "./graph_library/Graph";
import GraphVertex from "./graph_library/GraphVertex";
import GraphEdge from "./graph_library/GraphEdge";

/**
 * @param {Graph} graph
 * @param {GraphVertex} startVertex
 * @param {number} maxDepth
 * @return {{distances, previousVertices, cyclePaths}}
 */
export default function bellmanFord(graph: Graph, startVertex: GraphVertex, maxDepth: number = 4) {
    const distances: { [key: string]: number } = {};
    const previousVertices: { [key: string]: GraphVertex | null } = {};
    const paths: { [key: string]: string[] } = {};

    // Inicialización
    graph.getAllVertices().forEach((vertex) => {
        const vertexKey = vertex.getKey();
        distances[vertexKey] = vertexKey === startVertex.getKey() ? 0 : Infinity;
        previousVertices[vertexKey] = null;
        paths[vertexKey] = [vertexKey];
    });

    // Relajación de aristas
    for (let i = 0; i < Math.min(graph.getAllVertices().length - 1, maxDepth); i++) {
        let edges = graph.getAllEdges();
        for (let edge of edges) {
            let from = edge.startVertex;
            let to = edge.endVertex;
            const fromKey = from.getKey();
            const toKey = to.getKey();
            if (distances[fromKey] + edge.weight < distances[toKey]) {
                distances[toKey] = distances[fromKey] + edge.weight;
                previousVertices[toKey] = from;
                paths[toKey] = [...paths[fromKey], toKey];
            }
        }
    }

    // Detección de ciclos negativos (oportunidades de arbitraje)
    let cyclePaths: string[][] = [];
    let foundCycles: { [key: string]: boolean } = {};
    let edges = graph.getAllEdges();
    for (let edge of edges) {
        let from = edge.startVertex;
        let to = edge.endVertex;
        const fromKey = from.getKey();
        const toKey = to.getKey();
        if (distances[fromKey] + edge.weight < distances[toKey]) {
            let cycle = detectCycle(to, previousVertices);
            if (cycle) {
                let uniquePath = cycle.join('');
                if (!foundCycles[uniquePath] && cycle.length <= maxDepth) {
                    cyclePaths.push(cycle);
                    foundCycles[uniquePath] = true;
                }
            }
        }
    }

    return {
        distances,
        previousVertices,
        cyclePaths
    };
}

/**
 * Detecta y retorna un ciclo si existe
 * @param {GraphVertex} vertex
 * @param {Object} previousVertices
 * @return {string[] | null}
 */
function detectCycle(vertex: GraphVertex, previousVertices: { [key: string]: GraphVertex | null }): string[] | null {
    let visited = new Set<string>();
    let cycle: string[] = [];
    let current: GraphVertex | null = vertex;

    while (current && !visited.has(current.getKey())) {
        visited.add(current.getKey());
        cycle.push(current.getKey());
        current = previousVertices[current.getKey()];
    }

    if (current && cycle.includes(current.getKey())) {
        let startIndex = cycle.indexOf(current.getKey());
        return cycle.slice(startIndex);
    }

    return null;
}