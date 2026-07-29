import { Workflow, NodeConnectionTypes, jsonParse } from 'n8n-workflow';
export default { fetch() { return new Response(typeof Workflow + ' ' + typeof jsonParse + ' ' + NodeConnectionTypes.Main); } };
