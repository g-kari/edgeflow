import { Workflow, NodeConnectionTypes, jsonParse, NodeHelpers } from 'n8n-workflow';
export default {
  async fetch() {
    const out = { Workflow: typeof Workflow, jsonParse: typeof jsonParse, main: NodeConnectionTypes.Main, NodeHelpers: typeof NodeHelpers };
    return new Response(JSON.stringify(out));
  }
};
