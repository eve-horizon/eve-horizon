export function outputJson(data: unknown, json: boolean, fallback?: string): void {
  if (json) {
    console.log(JSON.stringify(data));
    return;
  }
  if (fallback) {
    console.log(fallback);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}
