import {readFileSync,statSync,writeFileSync} from "node:fs";
import {basename,join} from "node:path";
import {strToU8,zipSync} from "fflate";
import {importResearchBundle} from "../app/lib/research-analysis.ts";
import {RESEARCH_BUNDLE_FILES} from "../app/lib/research-bundle.ts";
import {buildResearchEconomicsForensicAudit} from "../app/lib/research-economics/forensic-audit.ts";

const input=process.argv[2];
const outputIndex=process.argv.indexOf("--output");
const output=outputIndex>=0?process.argv[outputIndex+1]:null;
if(!input)throw new Error("Usage: npm run audit:research-economics -- <bundle-directory-or-zip> [--output audit.json]");

let bytes:Uint8Array;
if(statSync(input).isDirectory()){
 const files:Record<string,Uint8Array>={};
 for(const name of RESEARCH_BUNDLE_FILES)files[name]=strToU8(readFileSync(join(input,name),"utf8"));
 bytes=zipSync(files);
}else bytes=readFileSync(input);

const imported=importResearchBundle(bytes,basename(input));
if(imported.status==="invalid")throw new Error(`Bundle import failed:\n${imported.errors.join("\n")}`);
const serialized=`${JSON.stringify(buildResearchEconomicsForensicAudit(imported.dataset),null,2)}\n`;
if(output)writeFileSync(output,serialized,"utf8");
else process.stdout.write(serialized);
