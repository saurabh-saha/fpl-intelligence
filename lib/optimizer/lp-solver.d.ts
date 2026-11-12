declare module "javascript-lp-solver" {
  const solver: { Solve(model: unknown): Record<string, any> & { feasible: boolean } };
  export default solver;
}
