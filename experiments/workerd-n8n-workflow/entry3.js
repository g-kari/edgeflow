import { Workflow, NodeHelpers } from 'n8n-workflow';
export default {
  async fetch() {
    const res = {};
    try {
      const nodeTypes = {
        getByName: () => undefined,
        getByNameAndVersion: () => ({
          description: { name:'test', displayName:'T', version:1, group:['transform'], defaults:{}, inputs:['main'], outputs:['main'], properties:[] },
        }),
        getKnownTypes: () => ({}),
      };
      const wf = new Workflow({
        id: 'w1', name: 'demo', nodes: [{ id:'a', name:'Start', type:'test', typeVersion:1, position:[0,0], parameters:{} }],
        connections: {}, active: false, nodeTypes,
      });
      res.workflowConstructed = true;
      res.nodeNames = Object.keys(wf.nodes);
      // expression evaluation
      const expr = wf.expression;
      res.exprType = typeof expr;
      res.evalSimple = expr.getSimpleParameterValue(wf.nodes.Start, '={{ 1 + 2 }}', 'internal', {});
      res.evalStr = expr.getSimpleParameterValue(wf.nodes.Start, '={{ "ab".toUpperCase() }}', 'internal', {});
      res.evalExt = expr.getSimpleParameterValue(wf.nodes.Start, '={{ "hello world".toSnakeCase() }}', 'internal', {});
    } catch (e) { res.error = String(e && e.message || e); res.stack = String(e && e.stack||'').split('\n').slice(0,4); }
    return new Response(JSON.stringify(res, null, 1));
  }
};
