# Real-Time Fracture Interpretation & Treatment Optimization
## Technical Plan — Conference Demo + Production System

---

## Overview

The goal is to close the feedback loop between what a fracturing operation *measures* and what it *should do next*. The key challenge in unconventional fracturing is geological uncertainty: you cannot directly observe the formation you are fracturing into. What you can observe is the wellbore pressure response — and that response encodes information about the formation if you know how to read it.

This plan describes a system where:
1. **HPC simulations** pre-generate pressure responses for a representative ensemble of plausible downhole geological scenarios
2. **A real-time UI** overlays these simulated curves on a canvas where an operator can sketch (or upload) the actual measured pressure response
3. **An AI agent** matches the drawn/measured response to the ensemble, infers the most probable geological scenario, and recommends a treatment plan adjustment
4. **The agent then goes deeper**: if the initial match is ambiguous or partial, it reasons about what specific formation parameters could explain the discrepancy and autonomously commissions targeted follow-up simulations — narrowing the parameter space iteratively until it reaches a high-confidence interpretation and a more precise recommendation

The conference demo covers steps 1–3. Step 4 is the production-grade capability that turns a one-shot match into a genuine investigation loop.

The key insight behind step 4 is that the agent acts like a petrophysicist running DFIT analysis: it forms a hypothesis ("this looks like NF activation but the net pressure is too high — maybe NFs are present AND the rock is stiffer than S02 assumes"), designs an experiment (run a simulation with S02 formation type but increase Young's Modulus by 2 MMpsi), observes the result, and revises. The HPC cluster is the laboratory.

---

## Part 1: The Geological Uncertainty Space

### 1.1 What We Don't Know Going In

When a frac job begins, the key unknowns that drive pressure response variability are:

| Parameter | Range | Effect on Pressure |
|---|---|---|
| Formation permeability | 0.001 – 50 mD | Higher k → lower net pressure, faster leak-off |
| Natural fracture density | 0 – dense network | NF activation → sudden pressure drops (DFITs) |
| In-situ stress contrast (Sh_min) | ±500 – 2000 psi vs. expected | Controls fracture height growth, net pressure |
| Young's Modulus (stiffness) | 1 – 12 MMpsi | Stiffer rock → higher net pressure for same width |
| Poisson's Ratio | 0.15 – 0.35 | Controls stress-strain response during propagation |
| Formation fluid (pore pressure) | Sub- to over-pressured | Affects effective stress, leak-off rate |
| Tortuosity / near-wellbore complexity | Low – severe | Causes rapid early pressure rise, friction |
| Layer heterogeneity (interbedded) | Homogeneous – laminated | Causes fracture height barriers, step changes |

### 1.2 Representative Scenario Ensemble

Rather than Monte Carlo sampling (expensive), define **8–12 representative archetypes** that cover the plausible space for the target formation. Each archetype is a named geological "story":

| Scenario ID | Name | Key Characteristics | Expected Pressure Signature |
|---|---|---|---|
| S01 | Tight Homogeneous | Low k, high E, no NF | Steady rise, high net pressure plateau |
| S02 | Naturally Fractured | Moderate k, NF network | Pressure drops at NF activation, lower net pressure |
| S03 | Stress Barrier Present | High stress contrast adjacent layers | Early height arrest, pressure rise above ISIP |
| S04 | Soft/Ductile Formation | Low E, high Poisson | Low net pressure, wide fractures, rapid width growth |
| S05 | High Leak-off | High k or micro-fractures | Rapid pressure decline, efficiency < 30% |
| S06 | Near-wellbore Tortuosity | Complex perforation path | Sharp early pressure spike, then stabilization |
| S07 | Over-pressured Zone | High pore pressure | Lower effective stress, fracture initiates easily, sustained plateau |
| S08 | Screen-out Prone | Low k + high proppant friction | Gradual pressure rise through job, Nolte-Smith trending up |
| S09 | Multi-layer (Laminated) | Alternating hard/soft | Step-change pressure behavior, multiple height barriers |
| S10 | Ideal | Moderate everything | Textbook Nolte-Smith response |

These map directly onto the existing `FracturingParameters` type in [amplify/data/schemas/cfd.schema.ts](amplify/data/schemas/cfd.schema.ts), which already includes `permeability`, `porosity`, `youngsModulus`, `poissonRatio`, and stress fields.

---

## Part 2: HPC Simulation Pipeline

### 2.1 Current State

The infrastructure already exists in skeletal form:

- **SLURM job submission**: [amplify/functions/slurm-job-submitter/submitJob.ts](amplify/functions/slurm-job-submitter/submitJob.ts) submits jobs via SSM to the cluster login node
- **CFD simulation management**: [amplify/functions/cfd-simulation-manager/](amplify/functions/cfd-simulation-manager/) handles submit, status polling, results retrieval, and snapshot generation
- **Data models**: `CFDSimulation`, `SimulationSnapshot`, `FracturingParameters`, `PumpingScheduleStage` all defined in [amplify/data/schemas/cfd.schema.ts](amplify/data/schemas/cfd.schema.ts)
- **Agent tool**: `evaluate-treatment-plan` in [cdk/lib/agent-server/src/tools/cfdSimulationTools.ts](cdk/lib/agent-server/src/tools/cfdSimulationTools.ts)
- **HPC feasibility study**: [docs/hpc/genai_hpc_cfd_screen_out_feasibility.md](docs/hpc/genai_hpc_cfd_screen_out_feasibility.md) recommends DuMux on AWS ParallelCluster

### 2.2 What Needs to Be Built

#### Step 1: Ensemble Simulation Runner

A new Lambda function `runEnsembleSimulation` that:
1. Accepts a base treatment plan (pump rate schedule, fluid type, proppant concentration ramp)
2. Expands it into N scenario variants by substituting each archetype's formation parameters
3. Submits all N jobs to the SLURM cluster concurrently (existing `submitSlurmJob` mutation)
4. Polls for completion and collects pressure-vs-time curves from each
5. Stores results as `EnsembleSimulationRun` → array of `ScenarioResult` in DynamoDB

Each `ScenarioResult` should store:
- `scenarioId` (S01–S10)
- `pressureTimeSeries`: array of `{t: number, p: number}` sampled at ~5-second intervals
- `derivativeTimeSeries`: `dP/dt` and `dP/d(log t)` (Nolte-Smith slope)
- Key inflection points: ISIP, fracture extension pressure, closure pressure
- `fractureGeometry`: estimated length/height/width at job end
- `placementEfficiency`: 0–1

#### Step 2: Pressure Curve Extraction

The existing simulation produces snapshots ([SimulationSnapshot](amplify/data/schemas/cfd.schema.ts)) as images. For the interpretation system we need the **numerical** wellbore pressure as a function of time, not just visualization frames. The solver output (OpenFOAM/DuMux) writes this to a `p_wf.csv` or equivalent probe file at the wellbore boundary. The post-processing Lambda needs to:
1. Read the probe file from S3
2. Resample to a uniform time grid
3. Apply wellbore storage correction (convert bottomhole to surface treating pressure if needed)
4. Store normalized `[0,1]` time and pressure arrays for frontend rendering

#### Step 3: Schema Additions

New types to add to [amplify/data/schemas/cfd.schema.ts](amplify/data/schemas/cfd.schema.ts):

```typescript
// Ensemble run grouping N scenario simulations
EnsembleSimulationRun {
  id, name, baseTreatmentPlanId, wellId
  status: "queued" | "running" | "completed" | "failed"
  scenarios: hasMany ScenarioSimulationResult
  createdAt, completedAt
}

// One simulation within the ensemble
ScenarioSimulationResult {
  id, ensembleRunId, scenarioId, scenarioName
  cfdSimulationId  // FK to existing CFDSimulation
  pressureTimeSeries: string  // JSON array [{t,p}]
  derivativeTimeSeries: string  // JSON array [{t,dpdt,dpdlogt}]
  nolteSmithSlope: float  // final slope for screen-out diagnosis
  isip: float, closurePressure: float
  fractureLength: float, fractureHeight: float, fractureWidth: float
  placementEfficiency: float
  status: "running" | "completed" | "failed"
}
```

---

## Part 3: Pressure Interpretation Engine

### 3.1 What the Matching Does

Given a measured (or hand-drawn) pressure-vs-time curve, the system needs to:

1. **Extract diagnostic features** from the curve:
   - Initial instantaneous shut-in pressure (ISIP)
   - Net pressure at end of job
   - Nolte-Smith slope (d log ΔP / d log t): positive = confined height, unit slope = fracture height growth, negative slope = T-shape/NF activation
   - Rate of pressure rise in early time (indicator of near-wellbore tortuosity)
   - Whether pressure exceeds maximum expected (stress barrier hit)
   - Leak-off behavior post shut-in (G-function analysis)
   - Any step changes (NF activation events)

2. **Compare features to ensemble**: compute a similarity score between the measured feature vector and each scenario's feature vector

3. **Return ranked scenarios** with probability weights: "Your pressure response is most consistent with S02 (Naturally Fractured Formation) with 68% confidence, followed by S05 (High Leak-off) at 22%"

4. **Generate a recommendation** conditioned on the top scenario(s)

### 3.2 Feature Extraction (Algorithmic, runs in Lambda)

```
Input: pressure time series P(t), pump rate Q(t), proppant concentration C(t)
Output: feature vector F

F = {
  netPressureAtEndOfJob: P_final - ISIP,
  nolteSmithSlope: linear_fit(log(dP), log(t)) over stable propagation phase,
  earlyTimeRiseRate: (P[120s] - P[0]) / 120,  // psi/sec
  normalizedISIP: ISIP / surfaceBreakdownPressure,
  stepChangeCount: count of |dP/dt| > threshold events,
  leakoffDeclineRate: exponential_fit(P(t) post shutin),
  maxNetPressure: max(P - Sh_min),
  pressureAtHalfVolume: P at cumulative volume = 0.5 * total_volume
}
```

The same extractor runs on the simulated curves to build the reference library. Matching is cosine similarity on normalized feature vectors.

### 3.3 Agent Tool: `interpret-pressure-response`

New tool to add to the agent server ([cdk/lib/agent-server/src/tools/](cdk/lib/agent-server/src/tools/)):

```typescript
// Input
{
  ensembleRunId: string,       // which ensemble to compare against
  pressureTimeSeries: {t: number, p: number}[],  // measured or drawn curve
  pumpRate: number,            // average bbl/min during job
  totalVolumePumped: number,   // bbl
  currentStage: number
}

// Output
{
  topScenarios: [
    { scenarioId, scenarioName, confidence: 0-1, diagnosticFeatures }
  ],
  interpretation: string,      // natural language explanation
  recommendation: {
    action: string,            // "increase_pad_volume" | "reduce_proppant_concentration" | etc.
    rationale: string,
    urgency: "monitor" | "adjust_next_stage" | "stop_and_reassess",
    specificChanges: {
      proppantConcentration?: { from: number, to: number, unit: "ppg" },
      pumpRate?: { from: number, to: number, unit: "bbl/min" },
      fluidType?: { from: string, to: string },
      padVolume?: { additionalGallons: number }
    }
  }
}
```

The agent uses this tool's structured output combined with its own reasoning (via Claude) to generate a natural-language recommendation in the chat interface.

---

## Part 4: Adaptive Simulation Loop (Agent-Driven Investigation)

### 4.1 The Core Idea

The initial ensemble match gives a probability distribution over known scenario archetypes. But real formations are not archetypes — they are combinations of factors, and the initial match often returns something like:

```
S02 Naturally Fractured:  44%
S05 High Leak-off:        31%
S08 Screen-out Prone:     18%
(other)                    7%
```

A human expert looking at this would not stop here. They would ask: *"What if it's S02 but with unusually high leak-off? That would explain both signals."* Then they would mentally (or physically) run that combined scenario and check if it fits better.

The adaptive simulation loop makes the agent do exactly this. It:
1. Identifies the **residual error** between the measured curve and the top-matched scenario
2. Uses that residual to hypothesize which parameters are most likely misspecified
3. Generates a small number of targeted follow-up simulations (3–5, not a new full ensemble)
4. Compares the new results against the measured curve
5. Repeats until the residual falls below a threshold or a stopping criterion is met
6. Uses the converged parameter set for its final recommendation

### 4.2 Residual Analysis: What Doesn't Fit

After the initial match against S02 (Naturally Fractured), the agent computes the signed residual at key diagnostic points:

```
residual = measured_feature - best_match_feature

Example:
  earlyTimeRiseRate:    measured=18 psi/s, S02=11 psi/s → residual=+7 psi/s (too low)
  nolteSmithSlope:      measured=-0.4,     S02=-0.5      → residual=+0.1 (close)
  maxNetPressure:       measured=2800 psi, S02=2100 psi  → residual=+700 psi (too low)
  leakoffDeclineRate:   measured=0.031,    S02=0.028     → residual=+0.003 (slight)
```

The large positive residuals on `earlyTimeRiseRate` and `maxNetPressure` point to a specific hypothesis: **the formation has natural fractures (explaining the NF activation signature) but is also stiffer than S02 assumes** (explaining why net pressure and early-time rise rate are both higher than S02 predicts).

### 4.3 Hypothesis Generation (Claude's Reasoning Step)

The agent uses Claude to translate the residual vector into hypotheses. This is a structured reasoning step, not free-form generation. The agent is prompted with:

- The feature residual vector
- A lookup table mapping each feature to the formation parameters it is most sensitive to (derived from sensitivity analysis on the ensemble)
- The current best-match scenario's parameter values
- A list of allowed parameter perturbations and their bounds

**Sensitivity lookup (embedded in agent system prompt):**

| Feature | Primary Driver | Secondary Driver |
|---|---|---|
| `earlyTimeRiseRate` | Tortuosity, near-wellbore friction | Young's Modulus |
| `nolteSmithSlope` | NF density, fracture height confinement | Stress contrast |
| `maxNetPressure` | Young's Modulus, Poisson's Ratio | Fracture geometry |
| `leakoffDeclineRate` | Permeability, NF aperture | Pore pressure |
| `stepChangeCount` | NF density, NF orientation | Stress anisotropy |
| `ISIP` | Minimum horizontal stress | Pore pressure |
| `pressureAtHalfVolume` | Leak-off coefficient, efficiency | Fracture compliance |

Claude returns a structured hypothesis set:

```json
{
  "hypotheses": [
    {
      "id": "H1",
      "description": "S02 base + increased Young's Modulus",
      "rationale": "maxNetPressure residual +700 psi and elevated earlyTimeRiseRate both consistent with stiffer rock than S02 assumes",
      "parameterDelta": {
        "youngsModulus": { "from": 4.5, "to": 7.0, "unit": "MMpsi" }
      },
      "expectedResidualReduction": 0.65
    },
    {
      "id": "H2",
      "description": "S02 base + near-wellbore tortuosity added",
      "rationale": "earlyTimeRiseRate residual alone could indicate tortuosity without needing to change bulk modulus",
      "parameterDelta": {
        "tortuosityFactor": { "from": 0.0, "to": 0.35 }
      },
      "expectedResidualReduction": 0.40
    },
    {
      "id": "H3",
      "description": "S02 base + increased E + moderate tortuosity",
      "rationale": "Combined explanation for both residuals",
      "parameterDelta": {
        "youngsModulus": { "from": 4.5, "to": 6.2, "unit": "MMpsi" },
        "tortuosityFactor": { "from": 0.0, "to": 0.20 }
      },
      "expectedResidualReduction": 0.78
    }
  ]
}
```

The agent selects the top N hypotheses (default 3) ranked by `expectedResidualReduction` and submits them as HPC jobs.

### 4.4 New Agent Tool: `run-hypothesis-simulations`

This tool encapsulates the submit + poll + compare cycle:

```typescript
// Input
{
  baseScenarioId: string,              // e.g. "S02"
  baseTreatmentPlan: TreatmentPlan,
  hypotheses: [
    {
      id: string,
      parameterDeltas: Partial<FracturingParameters>
    }
  ],
  measuredCurve: {t: number, p: number}[],
  maxWaitSeconds: number               // default 300 (5 min)
}

// Output
{
  hypothesisResults: [
    {
      hypothesisId: string,
      simulationId: string,
      pressureTimeSeries: {t: number, p: number}[],
      residualRMS: number,             // root-mean-square residual vs measured
      featureResiduals: FeatureVector, // per-feature signed residuals
      converged: boolean               // residualRMS < threshold
    }
  ],
  bestHypothesis: string,             // hypothesis ID with lowest residualRMS
  convergenceAchieved: boolean,
  nextIterationRecommended: boolean,
  inferredFormationParameters: Partial<FracturingParameters>  // if converged
}
```

The tool is designed to be called repeatedly by the agent in a loop. Each call is one iteration. The agent decides whether to call it again based on `convergenceAchieved` and `nextIterationRecommended`.

### 4.5 Convergence Criteria & Stopping Rules

The loop stops when any of these conditions are met:

| Condition | Meaning |
|---|---|
| `residualRMS < 150 psi` | Simulated curve matches measured within noise | 
| `iteration >= 4` | Hard cap — 4 iterations × 3 sims = 12 targeted jobs max |
| `deltaResidualRMS < 50 psi` between iterations | Diminishing returns, agent has found the best achievable match |
| Time budget exceeded | In production: 8-minute wall time; demo: 5 minutes |
| Agent determines the response is a known archetype | Skip iteration, use exact archetype parameters |

When converged, the agent has a refined parameter set — not just "probably S02" but "S02 with E=6.8 MMpsi and moderate tortuosity" — which is the input to the treatment recommendation.

### 4.6 How This Improves Recommendations

The difference between a first-pass match and a converged investigation is significant:

**First-pass (S02 match only):**
> "Reduce proppant concentration 20% for natural fractures."

**After adaptive loop (S02 + stiff rock + tortuosity):**
> "Natural fractures are present but the formation is stiffer than typical (estimated E ≈ 6.8 MMpsi). Near-wellbore tortuosity is contributing to early pressure. Recommend: (1) extend pad by 300 gal to overcome tortuosity before proppant entry, (2) reduce proppant 15% (less aggressive than standard NF protocol since high stiffness limits fracture opening that would trap proppant), (3) maintain rate — do not reduce below 60 bbl/min as this would increase tortuosity friction further."

The specificity and correctness of recommendation (2) in particular depends on knowing E is high, not just that NFs are present. The adaptive loop is what produces that knowledge.

### 4.7 Schema Addition: `InvestigationSession`

Tracks the multi-iteration loop as a first-class object in the data model:

```typescript
InvestigationSession {
  id, ensembleRunId, wellId, operationId
  measuredCurveJson: string          // the input curve that triggered investigation
  status: "running" | "converged" | "stopped" | "failed"
  iterations: hasMany InvestigationIteration
  finalInferredParameters: string    // JSON Partial<FracturingParameters>
  finalResidualRMS: float
  finalRecommendation: string        // agent-generated text
  startedAt, completedAt
}

InvestigationIteration {
  id, sessionId, iterationNumber
  hypotheses: string                 // JSON array of hypothesis objects
  simulationIds: string              // JSON array of CFDSimulation IDs
  bestHypothesisId: string
  residualRMSBefore: float
  residualRMSAfter: float
  converged: boolean
  agentReasoning: string             // Claude's explanation of this iteration
  createdAt, completedAt
}
```

### 4.8 UI: Investigation Progress Panel

In the frontend, while the adaptive loop runs, show a live investigation status panel alongside the chart:

```
┌─────────────────────────────────────┐
│ 🔬 Investigating...  Iteration 2/4  │
│                                     │
│ Best match so far: S02 + stiff rock │
│ Residual: 380 psi → 210 psi        │
│                                     │
│ Running 3 targeted simulations...   │
│ ██████████░░░░░░░░  2/3 complete    │
│                                     │
│ Agent reasoning:                    │
│ "Elevated net pressure not fully    │
│  explained by NFs alone. Testing    │
│  E=6.2, 6.8, 7.5 MMpsi variants." │
└─────────────────────────────────────┘
```

Each new simulation result is plotted on the chart in real time as it arrives, so the user can watch the agent's hypothesis testing visually — the curves step closer to the measured line with each iteration.

---

## Part 5: Conference Demo App (Steps 1–3 Only)

### 4.1 Demo Flow (under 2 minutes)

```
QR code → /demo/fracture-interpreter

1. [Auto-load] Ensemble of 10 simulated pressure curves displayed on chart
   - X axis: Time (minutes), 0 → 90
   - Y axis: Treating pressure (psi), 3000 → 9000
   - Each curve: thin, semi-transparent, labeled with scenario name on hover
   - Color coding: cool colors = softer/higher-perm, warm = stiffer/lower-perm
   - Shaded envelope showing min/max bounds across ensemble

2. [Prompt] "Draw the pressure response you're seeing"
   - Touch/stylus/mouse drawing enabled on chart canvas
   - Drawn line rendered in bold white/yellow over the ensemble curves
   - Clear button to redraw

3. [Button] "Interpret My Response"
   - Sends drawn curve to agent
   - Loading state: "Analyzing against 10 geological scenarios..."
   - Result panel slides up from bottom:
     * Top match: scenario card with confidence bar
     * 2nd/3rd match: smaller cards
     * Recommendation box: bold text, specific action
     * e.g., "Your response matches a Naturally Fractured formation (68%).
               Recommend: Reduce proppant concentration from 4 to 2.5 ppg
               in next stage to avoid NF bridging. Add 500 gal pad."

4. [Optional] "Show me why" — expands to overlay the matched simulation curve
   on top of drawn curve, highlighting the matching diagnostic features
```

### 4.2 Frontend Components to Build

#### `FractureEnsembleChart.tsx`

Built on Plotly, extending the existing [CfdVisualization3D.tsx](src/components/CfdVisualization3D.tsx) and [SimulationMetricsSummary.tsx](src/components/SimulationMetricsSummary.tsx) patterns:

```typescript
// Renders ensemble curves + drawing canvas overlay
interface FractureEnsembleChartProps {
  ensembleRun: EnsembleSimulationRun     // from GraphQL
  onCurveDrawn: (points: {t: number, p: number}[]) => void
  matchedScenarioId?: string             // highlights matched curve
  drawnCurve?: {t: number, p: number}[]  // user's drawn line
}
```

Key implementation decisions:
- Use Plotly's `scatter` traces for simulated curves (one trace per scenario)
- Overlay a transparent HTML5 Canvas element for drawing, sized to match the Plotly plot area
- Convert canvas pixel coordinates to data coordinates using Plotly's `layout.xaxis.range` and `layout.yaxis.range`
- On draw complete, emit the point array in data coordinates

#### `InterpretationPanel.tsx`

Slide-up results panel showing:
- Ranked scenario cards with confidence bars
- Recommendation action with urgency color coding (green/yellow/red)
- Specific parameter change suggestions
- "Why?" expansion showing overlay comparison

#### `/app/demo/fracture-interpreter/page.tsx`

Self-contained demo page (no auth required for conference):
- Loads a pre-baked ensemble run (stored in DynamoDB, seeded for demo)
- Calls interpret API via a public-facing endpoint or API route
- No Cognito required — demo uses a read-only public API key

### 4.3 Drawing Interaction on Mobile

Since visitors will use phone cameras to scan the QR code:

- Canvas overlay must be touch-aware (`ontouchstart`, `ontouchmove`, `ontouchend`)
- Minimum line width 3px for finger drawing visibility
- Debounce point capture to ~50ms intervals to avoid overwhelming the curve
- Show "tap and drag to draw" instruction with animated hint on first load
- After drawing, show a "Done" button that freezes the curve and enables the interpret button
- Pressure range should be pre-scaled to a typical frac job so an approximate sketch is meaningful

---

## Part 6: Production System Integration

### 6.1 Real-Time Operation Flow

In production (not demo mode), the flow becomes:

```
Frac van data → WebSocket → Frontend chart (live pressure trace)
                                    ↓
                         Agent polls every 2 minutes:
                         "Does the current pressure trend
                          match any scenario shift?"
                                    ↓
                         If deviation detected:
                         → Notify operator in chat
                         → Show updated scenario probabilities
                         → Suggest treatment adjustment
```

This connects to the existing `SensorReading` model and `assessScreenOutRisk` tool in [amplify/functions/screen-out-predictor/](amplify/functions/screen-out-predictor/).

### 6.2 Connecting Ensemble Interpretation to the Screen-Out Predictor

The three-tier screen-out prediction system already in place can be extended:

- **Tier 1 (physics, <1s)**: Add ensemble-feature matching as an additional signal alongside existing physics indicators
- **Tier 2 (ROM, <30s)**: Train ROM to condition on `scenarioId` probability weights — if scenario S08 (screen-out prone) has high probability, ROM risk score increases
- **Tier 3 (CFD, <2 min)**: When ensemble match identifies a specific scenario, run a targeted CFD with *those exact formation parameters* instead of generic defaults

### 6.3 Treatment Optimization Conditioned on Scenario

Once the system identifies the most likely geological scenario, the existing optimization engine ([amplify/functions/continuous-optimization-engine/](amplify/functions/continuous-optimization-engine/)) can use scenario-conditioned parameters:

| Scenario Match | Recommended Parameter Adjustment |
|---|---|
| S02 Natural Fractures | Reduce proppant conc. 20%, increase pad volume 15%, consider diverter |
| S03 Stress Barrier | Consider tail-in rate increase to force height growth, check breakdown pressure vs. ISIP |
| S05 High Leak-off | Increase pump rate to compensate, add fluid loss additive, reassess stage volume |
| S06 Near-wellbore Tortuosity | Increase rate for tortuosity breakdown, extend pad phase, check perforation design |
| S08 Screen-out Prone | Reduce proppant concentration by 1–2 ppg, increase flush volume, consider stopping stage |

These recommendation rules get encoded in the agent's system prompt and the `interpret-pressure-response` tool's output, so Claude can synthesize them into natural language recommendations.

---

## Part 7: Implementation Roadmap

### Phase 0: Conference Demo (Target: ~3 weeks)

| Task | Status | Owner | Effort | Dependencies |
|---|---|---|---|---|
| Define 10 scenario parameter sets | ✅ Done | — | — | In `src/lib/fracture/scenarios.ts` |
| Synthetic pressure curve generation per scenario | ✅ Done | — | — | In `src/lib/fracture/syntheticCurves.ts` |
| Feature extraction utilities (Nolte-Smith, ISIP, etc.) | ✅ Done | — | — | In `src/lib/fracture/featureExtraction.ts` |
| Build `FractureEnsembleChart.tsx` (curves + touch/mouse drawing) | ✅ Done | — | — | In `src/components/FractureEnsembleChart.tsx` |
| Build `InterpretationPanel.tsx` | ✅ Done | — | — | In `src/components/InterpretationPanel.tsx` |
| Build public `/api/fracture-interpret` API route (no auth) | ✅ Done | — | — | In `src/app/api/fracture-interpret/route.ts` |
| Build conference demo page `/fracture-demo` (mobile-first) | ✅ Done | — | — | In `src/app/(without-layout)/fracture-demo/page.tsx` |
| Run ensemble simulations for real data | Pending | Eng | 3d | HPC cluster access |
| Seed demo data + test on mobile | Pending | Eng | 1d | All above |
| QR code + URL | Pending | — | 1h | Deployment |

### Phase 1: Automated Ensemble Runner (Post-conference, ~6 weeks)

| Task | Status | Effort |
|---|---|---|
| `runEnsembleSimulation` Lambda | ✅ Done | — |
| `EnsembleSimulationRun` / `ScenarioSimulationResult` schema + GraphQL | ✅ Done | — |
| `interpretPressureResponse` Lambda (feature matching) | ✅ Done | — |
| Agent tool `interpret-pressure-response` | ✅ Done | — |
| Agent tool `run-ensemble-simulation` | ✅ Done | — |
| Wire Lambda functions + schema into Amplify resource.ts | ✅ Done | — |
| Numerical pressure extraction from solver output (S3 → DynamoDB) | Pending | 1w |
| UI: ensemble chart auto-populated from live DynamoDB run | Pending | 1w |

### Phase 1.5: Adaptive Simulation Loop (~4 weeks, can overlap Phase 1)

| Task | Status | Effort |
|---|---|---|
| Sensitivity lookup table (feature → parameter driver mapping) | ✅ Done | — |
| Agent tool `run-hypothesis-simulations` (submit + poll + compare) | ✅ Done | — |
| `InvestigationSession` / `InvestigationIteration` schema + GraphQL | ✅ Done | — |
| `runHypothesisSimulations` Lambda with bounds validation | ✅ Done | — |
| `InvestigationProgressPanel.tsx` (live adaptive loop status UI) | ✅ Done | — |
| Hypothesis generator (Claude reasoning step) | Pending | 1w |
| Full convergence + stopping logic in agent loop | Pending | 3d |

### Phase 2: Real-Time Integration (Production, ~8 weeks)

| Task | Effort |
|---|---|
| Sensor data ingestion + live chart streaming | 2w |
| Agent polling loop + deviation detection | 1w |
| Scenario probability updating as job progresses | 2w |
| ROM training conditioned on scenario | 3w |
| Tier 3 CFD with scenario-specific formation params | 2w |
| Operator notification + approval workflow | 1w |

---

## Part 8: Key Technical Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Simulated pressure curves don't match real data | High initially | Start with published analogue well DFITs for calibration; add feedback loop |
| Drawing → data coordinate conversion is inaccurate | Medium | Validate with known synthetic curves before conference |
| HPC jobs take too long for real-time use | Medium | Pre-run ensemble before job starts; use ROM surrogates in-job |
| Mobile drawing UX is frustrating | Medium | Test on 5 different phones; provide "upload CSV" as fallback |
| Scenario ensemble doesn't cover actual geology | Medium | Include "unknown/hybrid" scenario + confidence threshold below which agent says "insufficient data" |
| Adaptive loop runs too many simulations / too slow | Medium | Hard cap of 4 iterations × 3 sims = 12 targeted jobs; use ROM surrogates for cheap iterations, CFD only for final confirmation |
| Hypothesis generator proposes physically unrealistic parameter combinations | Medium | Bounds-check all parameter deltas against known geological ranges before job submission; reject and explain if out of range |
| Agent loop does not converge (residual stays high) | Low-medium | After stopping criterion, agent reports best-achieved match with explicit uncertainty: "Best fit found but significant residual remains — recommend post-job G-function analysis for calibration" |
| Public demo page gets abused | Low | Rate-limit by IP, seed fixed demo data, don't expose real well data |

---

## Part 9: What This Enables Long-Term

The pressure interpretation system is a foundation for a learning loop:

1. **Job N**: Match pressure to ensemble → recommend treatment change
2. **Post-job N**: Log actual outcome (screen-out occurred? proppant placed as expected?)
3. **Calibration**: Adjust scenario parameters and feature weights based on actual outcomes
4. **Job N+1**: Narrower ensemble, higher-confidence matches, better recommendations

Over 20–50 jobs on the same field, the system's geological model of that field converges. The ensemble shrinks from 10 generic scenarios to 3–4 calibrated archetypes for that specific formation. This is the core value proposition: **the system gets smarter with every frac job**.

---

## Appendix: Existing Code Touchpoints

| Component | File |
|---|---|
| CFD simulation data model | [amplify/data/schemas/cfd.schema.ts](amplify/data/schemas/cfd.schema.ts) |
| Screen-out prediction | [amplify/data/schemas/screenout.schema.ts](amplify/data/schemas/screenout.schema.ts) |
| SLURM job submission | [amplify/functions/slurm-job-submitter/submitJob.ts](amplify/functions/slurm-job-submitter/submitJob.ts) |
| CFD simulation manager | [amplify/functions/cfd-simulation-manager/](amplify/functions/cfd-simulation-manager/) |
| Optimization engine | [amplify/functions/continuous-optimization-engine/](amplify/functions/continuous-optimization-engine/) |
| Agent CFD tool | [cdk/lib/agent-server/src/tools/cfdSimulationTools.ts](cdk/lib/agent-server/src/tools/cfdSimulationTools.ts) |
| Agent screen-out tools | [cdk/lib/agent-server/src/tools/screenOutTools.ts](cdk/lib/agent-server/src/tools/screenOutTools.ts) |
| 3D fracture visualization | [src/components/CfdVisualization3D.tsx](src/components/CfdVisualization3D.tsx) |
| Simulation metrics UI | [src/components/SimulationMetricsSummary.tsx](src/components/SimulationMetricsSummary.tsx) |
| HPC feasibility study | [docs/hpc/genai_hpc_cfd_screen_out_feasibility.md](docs/hpc/genai_hpc_cfd_screen_out_feasibility.md) |
