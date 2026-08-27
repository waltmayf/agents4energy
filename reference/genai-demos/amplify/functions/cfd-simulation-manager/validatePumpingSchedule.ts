/**
 * Pumping Schedule Validator
 *
 * Pure function that validates a PumpingSchedule object.
 * Shared between the Lambda handler and the frontend editor.
 */

export interface PumpingScheduleStage {
  stageType: 'pad' | 'slurry' | 'flush';
  startTimeSeconds: number;
  endTimeSeconds: number;
  pumpRateBblMin: number;
  proppantConcentrationPpg: number;
  fluidViscosityCp: number;
}

export interface PumpingSchedule {
  stages: PumpingScheduleStage[];
  totalDurationSeconds: number;
}

export interface ValidationError {
  stageIndex: number;
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate a pumping schedule for completeness and consistency.
 *
 * Rules (from Requirements 2.1–2.8):
 * - At least one stage
 * - Each stage: endTimeSeconds > startTimeSeconds
 * - Contiguous: stages[i].startTimeSeconds === stages[i-1].endTimeSeconds
 * - pumpRateBblMin > 0 for every stage
 * - proppantConcentrationPpg >= 0 for every stage
 * - fluidViscosityCp > 0 for every stage
 * - totalDurationSeconds === stages[last].endTimeSeconds
 */
export function validatePumpingSchedule(schedule: PumpingSchedule): ValidationResult {
  const errors: ValidationError[] = [];

  if (!schedule.stages || schedule.stages.length === 0) {
    errors.push({ stageIndex: -1, field: 'stages', message: 'Schedule must contain at least one stage' });
    return { valid: false, errors };
  }

  for (let i = 0; i < schedule.stages.length; i++) {
    const stage = schedule.stages[i];

    if (stage.endTimeSeconds <= stage.startTimeSeconds) {
      errors.push({
        stageIndex: i,
        field: 'endTimeSeconds',
        message: `Stage ${i + 1}: endTimeSeconds (${stage.endTimeSeconds}) must be greater than startTimeSeconds (${stage.startTimeSeconds})`,
      });
    }

    if (i > 0) {
      const prev = schedule.stages[i - 1];
      if (Math.abs(stage.startTimeSeconds - prev.endTimeSeconds) > 0.001) {
        errors.push({
          stageIndex: i,
          field: 'startTimeSeconds',
          message: `Stage ${i + 1}: startTimeSeconds (${stage.startTimeSeconds}) must equal previous stage endTimeSeconds (${prev.endTimeSeconds})`,
        });
      }
    }

    if (stage.pumpRateBblMin <= 0) {
      errors.push({
        stageIndex: i,
        field: 'pumpRateBblMin',
        message: `Stage ${i + 1}: pumpRateBblMin must be greater than 0 (got ${stage.pumpRateBblMin})`,
      });
    }

    if (stage.proppantConcentrationPpg < 0) {
      errors.push({
        stageIndex: i,
        field: 'proppantConcentrationPpg',
        message: `Stage ${i + 1}: proppantConcentrationPpg must be >= 0 (got ${stage.proppantConcentrationPpg})`,
      });
    }

    if (stage.fluidViscosityCp <= 0) {
      errors.push({
        stageIndex: i,
        field: 'fluidViscosityCp',
        message: `Stage ${i + 1}: fluidViscosityCp must be greater than 0 (got ${stage.fluidViscosityCp})`,
      });
    }
  }

  const lastStage = schedule.stages[schedule.stages.length - 1];
  if (Math.abs(schedule.totalDurationSeconds - lastStage.endTimeSeconds) > 0.001) {
    errors.push({
      stageIndex: -1,
      field: 'totalDurationSeconds',
      message: `totalDurationSeconds (${schedule.totalDurationSeconds}) must equal last stage endTimeSeconds (${lastStage.endTimeSeconds})`,
    });
  }

  return { valid: errors.length === 0, errors };
}
