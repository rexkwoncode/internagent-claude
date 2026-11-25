export function traverse(graph, start) {
  const distance = Array(graph.length).fill(-1);
  const queue = [start];
  distance[start] = 0;
  while (queue.length) {
    const vertex = queue.shift();
    for (const next of graph[vertex]) {
      if (distance[next] >= 0) continue;
      distance[next] = distance[vertex] + 1;
      queue.push(next);
    }
  }
  return distance;
}
