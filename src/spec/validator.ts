import * as AjvModule from 'ajv';
const Ajv = (AjvModule as any).default ?? AjvModule;
import type { OpenApiManifest } from './types.js';

const capabilitySchema = {
  type: 'object', required: ['id','intent_examples','read_only','freshness','output','side_effects','consent'],
  properties: {
    id: {type:'string', minLength:1}, intent_examples: {type:'array', minItems:1, items:{type:'string'}},
    read_only: {type:'boolean'}, freshness: {type:'object', required:['max_age_seconds'], properties:{max_age_seconds:{type:'integer', minimum:0}}, additionalProperties:false},
    output: {type:'object', minProperties:1, additionalProperties:{type:'string'}}, side_effects:{enum:['none','read','write','destructive']}, consent:{enum:['none','user','always']},
    auth:{type:'object', properties:{type:{enum:['none','bearer','oauth2','cookie','browser-session']}, scopes:{type:'array',items:{type:'string'}}}, required:['type'], additionalProperties:false},
    rate_limit:{type:'object', properties:{requests_per_minute:{type:'integer',minimum:1},burst:{type:'integer',minimum:1}}, additionalProperties:false},
    source:{type:'object'}, version:{type:'string'}
  }, additionalProperties:false
};
const operationSchema = {
  type:'object', required:['responses','x-agent-capability'], properties:{
    operationId:{type:'string'}, parameters:{type:'array',items:{type:'object',required:['name','in','schema'],properties:{name:{type:'string'},in:{enum:['path','query','header','cookie']},required:{type:'boolean'},schema:{type:'object'}},additionalProperties:true}},
    responses:{type:'object',minProperties:1}, 'x-agent-capability': capabilitySchema
  }, additionalProperties:true
};
const manifestSchema = {type:'object', required:['openapi','info','paths'], properties:{openapi:{type:'string',pattern:'^3\\.1\\.'},info:{type:'object',required:['title','version'],properties:{title:{type:'string'},version:{type:'string'}},additionalProperties:true},servers:{type:'array',items:{type:'object',required:['url'],properties:{url:{type:'string'}},additionalProperties:true}},paths:{type:'object',minProperties:1,additionalProperties:{type:'object',additionalProperties:operationSchema}},components:{type:'object'},'x-agent-provider':{type:'object'}}, additionalProperties:true};

const ajv = new Ajv({allErrors:true, strict:false});
const validate = ajv.compile(manifestSchema);
export function validateManifest(value: unknown): asserts value is OpenApiManifest {
  if (!validate(value)) throw new Error(`Invalid OpenAPI Agent manifest: ${ajv.errorsText(validate.errors)}`);
  for (const [path, item] of Object.entries((value as OpenApiManifest).paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get','post','put','patch','delete','head'].includes(method)) continue;
      if (!operation || !(operation as any)['x-agent-capability']) throw new Error(`Operation ${method.toUpperCase()} ${path} is missing x-agent-capability`);
    }
  }
}
export function parseManifest(value: unknown): OpenApiManifest { validateManifest(value); return value; }
