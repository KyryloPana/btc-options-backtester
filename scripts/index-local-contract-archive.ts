#!/usr/bin/env node
import {indexLocalContractArchive} from "./local-contract-archive.ts";
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error("usage: index-local-contract-archive.ts INPUT_CONTRACT_DIRECTORY OUTPUT_TAPE_DIRECTORY");
console.log(JSON.stringify(await indexLocalContractArchive(input,output),null,2));
