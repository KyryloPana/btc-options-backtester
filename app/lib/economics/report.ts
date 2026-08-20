import type {AnalysisDataset} from "../research-analysis.ts";
import type {AnalysisConfiguration} from "../analysis-configuration.ts";
import {validateEconomicPolicy} from "../analysis-configuration.ts";
import {normalizePositionEconomics} from "./position.ts";
import {reconstructPortfolio} from "./portfolio.ts";
export function buildEconomicReport(dataset:AnalysisDataset,configuration:AnalysisConfiguration){const positions=normalizePositionEconomics(dataset,configuration),portfolio=reconstructPortfolio(positions,configuration);return{configuration:{executionScenario:configuration.executionAssumption,pricingTrack:configuration.pricingTrack,exitPolicy:configuration.exitPolicy,marginModel:configuration.marginModel,collateralMode:configuration.collateralMode,maximumRiskFraction:configuration.maximumRiskFraction,maximumMarginUtilization:configuration.maximumMarginUtilization},configurationErrors:validateEconomicPolicy(configuration),capabilities:{maximumLoss:positions.some(x=>x.maximumEconomicLossBtc.value!==null),openingMargin:positions.some(x=>x.incrementalInitialMarginBtc.value!==null),peakMargin:positions.some(x=>x.peakInitialMarginBtc.value!==null),portfolioMargin:false},positions,portfolio};}
export type EconomicReport=ReturnType<typeof buildEconomicReport>;
