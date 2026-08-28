// Treatment-plan input schema for the CFD tools (issue #504, epic #498 slice 6).
// Ported from reference/genai-demos' cfdSimulationTools.ts (agent-facing shape)
// + cfd-simulation-manager/submitCfdSimulation.ts (validation ranges) and
// validatePumpingSchedule.ts (pumping-schedule contiguity rules).

export type StageType = 'pad' | 'slurry' | 'flush';

export interface PumpingScheduleStage {
  stageType: StageType;
  startTimeSeconds: number;
  endTimeSeconds: number;
  pumpRateBblMin: number;
  proppantConcentrationPpg: number;
  fluidViscosityCp: number;
}

export interface TreatmentPlan {
  injectionRate: number;
  proppantConcentration: number;
  fluidViscosity: number;
  treatingPressure: number;
  fractureLengthM?: number;
  fractureWidthMm?: number;
  /** Pumping schedule (pad -> slurry -> flush). Presence selects the transient (pimpleFoam) solver path over the steady (simpleFoam) one. */
  stages?: PumpingScheduleStage[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const RANGES = {
  injectionRate: { min: 0.1, max: 0.5, unit: 'm³/s' },
  proppantConcentration: { min: 0.1, max: 0.4, unit: 'volume fraction' },
  fluidViscosity: { min: 0.01, max: 0.1, unit: 'Pa·s' },
} as const;

function validateStages(stages: PumpingScheduleStage[]): string[] {
  const errors: string[] = [];
  if (stages.length === 0) {
    errors.push('stages must contain at least one stage when provided');
    return errors;
  }

  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    const label = `stages[${i}]`;

    if (stage.endTimeSeconds <= stage.startTimeSeconds) {
      errors.push(`${label}.endTimeSeconds (${stage.endTimeSeconds}) must be greater than startTimeSeconds (${stage.startTimeSeconds})`);
    }
    if (i > 0) {
      const prev = stages[i - 1];
      if (Math.abs(stage.startTimeSeconds - prev.endTimeSeconds) > 0.001) {
        errors.push(`${label}.startTimeSeconds (${stage.startTimeSeconds}) must equal the previous stage's endTimeSeconds (${prev.endTimeSeconds})`);
      }
    }
    if (stage.pumpRateBblMin <= 0) {
      errors.push(`${label}.pumpRateBblMin must be greater than 0 (got ${stage.pumpRateBblMin})`);
    }
    if (stage.proppantConcentrationPpg < 0) {
      errors.push(`${label}.proppantConcentrationPpg must be >= 0 (got ${stage.proppantConcentrationPpg})`);
    }
    if (stage.fluidViscosityCp <= 0) {
      errors.push(`${label}.fluidViscosityCp must be greater than 0 (got ${stage.fluidViscosityCp})`);
    }
  }

  return errors;
}

/** Validates a treatment plan's ranges (Requirements 13.1-13.5 in the reference impl) plus pumping-schedule contiguity. */
export function validateTreatmentPlan(plan: Partial<TreatmentPlan>): ValidationResult {
  const errors: string[] = [];

  if (plan.injectionRate === undefined || plan.injectionRate === null) {
    errors.push('injectionRate is required');
  } else if (plan.injectionRate < RANGES.injectionRate.min || plan.injectionRate > RANGES.injectionRate.max) {
    errors.push(`injectionRate must be between ${RANGES.injectionRate.min} and ${RANGES.injectionRate.max} ${RANGES.injectionRate.unit} (got ${plan.injectionRate})`);
  }

  if (plan.proppantConcentration === undefined || plan.proppantConcentration === null) {
    errors.push('proppantConcentration is required');
  } else if (plan.proppantConcentration < RANGES.proppantConcentration.min || plan.proppantConcentration > RANGES.proppantConcentration.max) {
    errors.push(`proppantConcentration must be between ${RANGES.proppantConcentration.min} and ${RANGES.proppantConcentration.max} ${RANGES.proppantConcentration.unit} (got ${plan.proppantConcentration})`);
  }

  if (plan.fluidViscosity === undefined || plan.fluidViscosity === null) {
    errors.push('fluidViscosity is required');
  } else if (plan.fluidViscosity < RANGES.fluidViscosity.min || plan.fluidViscosity > RANGES.fluidViscosity.max) {
    errors.push(`fluidViscosity must be between ${RANGES.fluidViscosity.min} and ${RANGES.fluidViscosity.max} ${RANGES.fluidViscosity.unit} (got ${plan.fluidViscosity})`);
  }

  if (plan.treatingPressure === undefined || plan.treatingPressure === null) {
    errors.push('treatingPressure is required');
  } else if (plan.treatingPressure <= 0) {
    errors.push(`treatingPressure must be positive (got ${plan.treatingPressure})`);
  }

  if (plan.fractureLengthM !== undefined && plan.fractureLengthM <= 0) {
    errors.push(`fractureLengthM must be positive if provided (got ${plan.fractureLengthM})`);
  }
  if (plan.fractureWidthMm !== undefined && plan.fractureWidthMm <= 0) {
    errors.push(`fractureWidthMm must be positive if provided (got ${plan.fractureWidthMm})`);
  }

  if (plan.stages !== undefined) {
    if (!Array.isArray(plan.stages)) {
      errors.push('stages must be an array when provided');
    } else {
      errors.push(...validateStages(plan.stages));
    }
  }

  return { valid: errors.length === 0, errors };
}
