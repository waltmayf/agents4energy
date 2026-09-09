#!/usr/bin/env python3
"""
OpenFOAM CFD Post-Processing Metrics Calculator

Reads OpenFOAM simulation results and computes optimization and risk metrics
for hydraulic fracturing simulations. Outputs results/metrics.json.

Usage:
    python3 calculate_metrics.py \
        --work-dir /path/to/case \
        --injection-rate 0.3 \
        --proppant-concentration 0.25 \
        --fluid-viscosity 0.05
"""

import argparse
import json
import math
import os
import re
import sys

import numpy as np


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    """Parse command-line arguments for the metrics calculator."""
    parser = argparse.ArgumentParser(
        description="Compute optimization and risk metrics from OpenFOAM results"
    )
    parser.add_argument(
        "--work-dir",
        required=True,
        help="Path to the OpenFOAM case working directory",
    )
    parser.add_argument(
        "--injection-rate",
        type=float,
        required=True,
        help="Injection rate in m³/s",
    )
    parser.add_argument(
        "--proppant-concentration",
        type=float,
        required=True,
        help="Proppant concentration (volume fraction)",
    )
    parser.add_argument(
        "--fluid-viscosity",
        type=float,
        required=True,
        help="Fluid kinematic viscosity in m²/s",
    )
    parser.add_argument(
        "--transient",
        action="store_true",
        default=False,
        help="Process all timestep directories for transient simulations",
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# OpenFOAM directory / field file utilities
# ---------------------------------------------------------------------------

def find_latest_timestep(work_dir):
    """Scan *work_dir* for numeric sub-directories and return the path to the
    latest one (highest numeric value).  Returns ``None`` when no timestep
    directories are found.
    """
    timesteps = []
    for entry in os.listdir(work_dir):
        full = os.path.join(work_dir, entry)
        if not os.path.isdir(full):
            continue
        try:
            val = float(entry)
            # Skip the 0/ directory (initial conditions)
            if val > 0:
                timesteps.append((val, full))
        except ValueError:
            continue
    if not timesteps:
        return None
    timesteps.sort(key=lambda t: t[0])
    return timesteps[-1][1]


def find_all_timesteps(work_dir):
    """Return a list of (time_value, path) tuples for all non-zero timestep
    directories, sorted by time value ascending.  Returns an empty list when
    no timestep directories are found.
    """
    timesteps = []
    for entry in os.listdir(work_dir):
        full = os.path.join(work_dir, entry)
        if not os.path.isdir(full):
            continue
        try:
            val = float(entry)
            if val > 0:
                timesteps.append((val, full))
        except ValueError:
            continue
    timesteps.sort(key=lambda t: t[0])
    return timesteps


def read_openfoam_field(timestep_dir, field_name):
    """Parse an OpenFOAM ASCII field file and return a numpy array.

    Scalar fields  → 1-D array of shape ``(N,)``
    Vector fields  → 2-D array of shape ``(N, 3)``

    Supports both ``uniform`` and ``nonuniform List<scalar|vector>`` formats.
    Returns ``None`` if the file does not exist or cannot be parsed.
    """
    filepath = os.path.join(timestep_dir, field_name)
    if not os.path.isfile(filepath):
        return None

    try:
        with open(filepath, "r") as fh:
            content = fh.read()
    except OSError:
        return None

    return _parse_internal_field(content)


def _parse_internal_field(content):
    """Extract the ``internalField`` data from raw OpenFOAM file content."""

    # --- uniform scalar: internalField uniform VALUE; ---
    m = re.search(r"internalField\s+uniform\s+([-+eE\d.]+)\s*;", content)
    if m:
        return np.array([float(m.group(1))])

    # --- uniform vector: internalField uniform (vx vy vz); ---
    m = re.search(
        r"internalField\s+uniform\s+\(\s*([-+eE\d.]+)\s+([-+eE\d.]+)\s+([-+eE\d.]+)\s*\)\s*;",
        content,
    )
    if m:
        return np.array([[float(m.group(1)), float(m.group(2)), float(m.group(3))]])

    # --- nonuniform List<scalar> N ( v1 v2 ... ); ---
    m = re.search(
        r"internalField\s+nonuniform\s+List<scalar>\s+(\d+)\s*\(", content
    )
    if m:
        count = int(m.group(1))
        start = m.end()
        block = content[start:]
        nums = re.findall(r"[-+eE\d.]+", block)
        values = [float(v) for v in nums[:count]]
        return np.array(values)

    # --- nonuniform List<vector> N ( (vx vy vz) ... ); ---
    m = re.search(
        r"internalField\s+nonuniform\s+List<vector>\s+(\d+)\s*\(", content
    )
    if m:
        count = int(m.group(1))
        start = m.end()
        block = content[start:]
        tuples = re.findall(
            r"\(\s*([-+eE\d.]+)\s+([-+eE\d.]+)\s+([-+eE\d.]+)\s*\)", block
        )
        vectors = [(float(a), float(b), float(c)) for a, b, c in tuples[:count]]
        return np.array(vectors)

    return None


# ---------------------------------------------------------------------------
# Optimization metric functions
# ---------------------------------------------------------------------------

def compute_proppant_placement_efficiency(alpha, target=0.3):
    """Ratio of average near-wellbore proppant concentration to *target*.

    Near-wellbore is defined as the first 10% of cells.  Result is clamped
    to [0, 1].
    """
    n = len(alpha)
    near_count = max(1, math.floor(n * 0.1))
    near_mean = float(np.mean(alpha[:near_count]))
    return float(min(1.0, max(0.0, near_mean / target)))


def compute_fracture_geometry_score(U, domain_size):
    """Velocity-uniformity × volume score, clamped to [0, 1].

    *U* is an (N, 3) velocity array.  *domain_size* is a dict with keys
    ``x``, ``y``, ``z`` (metres).
    """
    magnitudes = np.linalg.norm(U, axis=1)
    mean_mag = float(np.mean(magnitudes))
    if mean_mag == 0:
        uniformity = 0.0
    else:
        std_mag = float(np.std(magnitudes))
        uniformity = max(0.0, 1.0 - std_mag / mean_mag)

    volume = domain_size["x"] * domain_size["y"] * domain_size["z"]
    ref_volume = 10000.0  # m³
    volume_score = min(1.0, volume / ref_volume)

    return float(min(1.0, max(0.0, uniformity * volume_score)))


def compute_placement_uniformity(alpha):
    """``max(0, 1 - stddev/mean)`` of the proppant concentration field.

    Returns 0 when the mean is zero (maximum non-uniformity).
    """
    mean_val = float(np.mean(alpha))
    if mean_val == 0:
        return 0.0
    std_val = float(np.std(alpha))
    return float(max(0.0, 1.0 - std_val / mean_val))


# ---------------------------------------------------------------------------
# Risk metric functions
# ---------------------------------------------------------------------------

def compute_concentration_risk(alpha, threshold=0.4):
    """``min(1, max(alpha) / threshold)``."""
    return float(min(1.0, float(np.max(alpha)) / threshold))


def compute_velocity_risk(U, critical=0.1):
    """``min(1, critical / min_velocity)`` when min velocity < *critical*,
    else 0.
    """
    magnitudes = np.linalg.norm(U, axis=1)
    min_vel = float(np.min(magnitudes))
    if min_vel < critical:
        if min_vel == 0:
            return 1.0
        return float(min(1.0, critical / min_vel))
    return 0.0


def compute_pressure_risk(p, critical=1000.0):
    """``min(1, max_gradient / critical)`` where *max_gradient* is the
    maximum absolute difference between consecutive pressure values.
    """
    if len(p) < 2:
        return 0.0
    gradients = np.abs(np.diff(p))
    max_gradient = float(np.max(gradients))
    return float(min(1.0, max_gradient / critical))


def compute_screen_out_risk(alpha, U, p):
    """Weighted composite risk:
    ``0.5 * concentration_risk + 0.3 * velocity_risk + 0.2 * pressure_risk``
    """
    conc = compute_concentration_risk(alpha)
    vel = compute_velocity_risk(U)
    pres = compute_pressure_risk(p)
    return float(0.5 * conc + 0.3 * vel + 0.2 * pres)


# ---------------------------------------------------------------------------
# Residual / log parsing
# ---------------------------------------------------------------------------

def parse_residuals(work_dir):
    """Attempt to parse final residuals and iteration count from the solver
    log file.  Looks for ``logs/`` directory or ``simulation.log`` in
    *work_dir*.

    Returns ``(residuals_dict, iteration_count)`` where *residuals_dict*
    has keys ``pressure``, ``velocity``, ``proppant`` and *iteration_count*
    is an ``int``.  Falls back to zeros when no log is found.
    """
    log_paths = [
        os.path.join(work_dir, "simpleFoam.log"),
        os.path.join(work_dir, "logs", "simpleFoam.log"),
        os.path.join(work_dir, "logs", "solver.log"),
        os.path.join(work_dir, "simulation.log"),
        os.path.join(work_dir, "log.simpleFoam"),
    ]

    log_content = None
    for lp in log_paths:
        if os.path.isfile(lp):
            try:
                with open(lp, "r") as fh:
                    log_content = fh.read()
                break
            except OSError:
                continue

    default_residuals = {"pressure": 0.0, "velocity": 0.0, "proppant": 0.0}
    if log_content is None:
        return default_residuals, 0

    return _extract_residuals(log_content)


def _extract_residuals(log_content):
    """Parse OpenFOAM solver log for final residuals and iteration count."""
    residuals = {"pressure": 0.0, "velocity": 0.0, "proppant": 0.0}
    iterations = 0

    # Match lines like: "Solving for p, Initial residual = 0.001, Final residual = 5e-05"
    p_matches = re.findall(
        r"Solving for p,.*?Final residual = ([-+eE\d.]+)", log_content
    )
    if p_matches:
        residuals["pressure"] = float(p_matches[-1])

    ux_matches = re.findall(
        r"Solving for Ux,.*?Final residual = ([-+eE\d.]+)", log_content
    )
    if ux_matches:
        residuals["velocity"] = float(ux_matches[-1])

    alpha_matches = re.findall(
        r"Solving for alpha\.proppant,.*?Final residual = ([-+eE\d.]+)",
        log_content,
    )
    if alpha_matches:
        residuals["proppant"] = float(alpha_matches[-1])

    # Count iterations from "Time = N" lines
    time_matches = re.findall(r"^Time = (\d+)", log_content, re.MULTILINE)
    if time_matches:
        iterations = int(time_matches[-1])

    return residuals, iterations


# ---------------------------------------------------------------------------
# Domain size detection
# ---------------------------------------------------------------------------

def detect_domain_size(work_dir):
    """Try to read domain dimensions from ``constant/polyMesh/blockMeshDict``
    or ``system/blockMeshDict``.  Returns a dict ``{x, y, z}`` in metres.
    Falls back to a default 100×100×0.1 domain.
    """
    default = {"x": 100.0, "y": 100.0, "z": 0.1}
    candidates = [
        os.path.join(work_dir, "constant", "polyMesh", "blockMeshDict"),
        os.path.join(work_dir, "system", "blockMeshDict"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r") as fh:
                    content = fh.read()
                return _parse_block_mesh_dict(content) or default
            except OSError:
                continue
    return default

def validate_cell_count(actual_cells, domain_size):
    """Warn if actual cell count is significantly lower than expected from mesh config.

    Expected cell count is estimated as:
        max(20, round(x/2)) × max(20, round(y/1.25)) × 8
    Logs a WARNING to stderr if actual < 50% of expected, but proceeds.
    """
    expected_x = max(20, round(domain_size["x"] / 2))
    expected_y = max(20, round(domain_size["y"] / 1.25))
    expected_z = 8
    expected = expected_x * expected_y * expected_z
    if actual_cells < expected * 0.5:
        print(
            f"WARNING: Cell count {actual_cells} is less than 50% of expected "
            f"{expected} for domain {domain_size}",
            file=sys.stderr,
        )



def _parse_block_mesh_dict(content):
    """Extract domain extents from a blockMeshDict vertices block.

    Looks for the ``vertices`` list and computes the bounding box from the
    vertex coordinates.
    """
    m = re.search(r"vertices\s*\(", content)
    if not m:
        return None
    block = content[m.end():]
    # Find all (x y z) tuples
    tuples = re.findall(
        r"\(\s*([-+eE\d.]+)\s+([-+eE\d.]+)\s+([-+eE\d.]+)\s*\)", block
    )
    if not tuples:
        return None
    xs = [float(t[0]) for t in tuples]
    ys = [float(t[1]) for t in tuples]
    zs = [float(t[2]) for t in tuples]
    return {
        "x": max(xs) - min(xs),
        "y": max(ys) - min(ys),
        "z": max(zs) - min(zs),
    }


# ---------------------------------------------------------------------------
# Main assembly
# ---------------------------------------------------------------------------

def compute_pressure_stats(p):
    """Compute pressure field statistics for treating pressure prediction.

    OpenFOAM solves for kinematic pressure (p/rho).  The values here are in
    the solver's native units (m²/s² for incompressible solvers).  The caller
    can convert to psi using fluid density if needed.

    Returns a dict with min, max, mean, inlet (first 10% of cells), and
    maxGradient values.
    """
    near_count = max(1, math.floor(len(p) * 0.1))
    inlet_pressure = float(np.mean(p[:near_count]))
    gradients = np.abs(np.diff(p)) if len(p) > 1 else np.array([0.0])
    return {
        "min": round(float(np.min(p)), 6),
        "max": round(float(np.max(p)), 6),
        "mean": round(float(np.mean(p)), 6),
        "inletPressure": round(inlet_pressure, 6),
        "maxGradient": round(float(np.max(gradients)), 6),
    }


def assemble_metrics(alpha, U, p, domain_size, residuals, iterations,
                     injection_rate, proppant_concentration, fluid_viscosity):
    """Build the full metrics dictionary matching the output JSON schema."""
    cell_count = len(alpha)
    near_count = max(1, math.floor(cell_count * 0.1))
    near_wellbore_conc = float(np.mean(alpha[:near_count]))

    return {
        "optimizationMetrics": {
            "proppantPlacementEfficiency": compute_proppant_placement_efficiency(alpha),
            "fractureGeometryScore": compute_fracture_geometry_score(U, domain_size),
            "placementUniformity": compute_placement_uniformity(alpha),
            "nearWellboreConcentration": round(near_wellbore_conc, 6),
        },
        "riskMetrics": {
            "screenOutRisk": compute_screen_out_risk(alpha, U, p),
            "concentrationRisk": compute_concentration_risk(alpha),
            "velocityRisk": compute_velocity_risk(U),
            "pressureRisk": compute_pressure_risk(p),
        },
        "pressureStats": compute_pressure_stats(p),
        "simulationInfo": {
            "finalResiduals": residuals,
            "iterations": iterations,
            "cellCount": cell_count,
            "domainSize": domain_size,
        },
        "simulationParams": {
            "injectionRate": injection_rate,
            "proppantConcentration": proppant_concentration,
            "fluidViscosity": fluid_viscosity,
        },
    }


# ---------------------------------------------------------------------------
# Transient metrics computation
# ---------------------------------------------------------------------------

def compute_timestep_metrics(timestep_dir, domain_size):
    """Compute metrics for a single timestep directory.

    Returns a dict with per-timestep metrics, or None if fields cannot be read.
    """
    alpha = read_openfoam_field(timestep_dir, "alpha.proppant")
    U = read_openfoam_field(timestep_dir, "U")
    p = read_openfoam_field(timestep_dir, "p")

    if alpha is None or U is None or p is None:
        return None

    if U.ndim == 1:
        U = U.reshape(1, -1)

    # Expand uniform fields
    cell_count = max(len(alpha), len(p), len(U))
    if len(alpha) == 1 and cell_count > 1:
        alpha = np.full(cell_count, alpha[0])
    if len(p) == 1 and cell_count > 1:
        p = np.full(cell_count, p[0])
    if len(U) == 1 and cell_count > 1:
        U = np.tile(U[0], (cell_count, 1))

    return {
        "pressureStats": compute_pressure_stats(p),
        "proppantPlacementEfficiency": compute_proppant_placement_efficiency(alpha),
        "placementUniformity": compute_placement_uniformity(alpha),
        "screenOutRisk": compute_screen_out_risk(alpha, U, p),
        "concentrationRisk": compute_concentration_risk(alpha),
        "velocityRisk": compute_velocity_risk(U),
        "pressureRisk": compute_pressure_risk(p),
        # Keep raw fields for aggregate computation
        "_alpha": alpha,
        "_U": U,
        "_p": p,
        "_cellCount": cell_count,
    }


def compute_transient_metrics(work_dir, args):
    """Process all timestep directories and produce metrics with timeSeries.

    Returns the full metrics dict including timeSeries array and
    predictedMaxTreatingPressure.
    """
    all_timesteps = find_all_timesteps(work_dir)
    if not all_timesteps:
        print(
            f"ERROR: --transient flag set but no timestep directories found in {work_dir}",
            file=sys.stderr,
        )
        sys.exit(1)

    domain_size = detect_domain_size(work_dir)
    time_series = []
    successful_count = 0

    for time_val, ts_dir in all_timesteps:
        ts_metrics = compute_timestep_metrics(ts_dir, domain_size)
        if ts_metrics is None:
            print(
                f"WARNING: Skipping timestep {time_val} -- missing field files in {ts_dir}",
                file=sys.stderr,
            )
            continue

        successful_count += 1
        time_series.append({
            "time": time_val,
            "pressureStats": ts_metrics["pressureStats"],
            "proppantPlacementEfficiency": ts_metrics["proppantPlacementEfficiency"],
            "placementUniformity": ts_metrics["placementUniformity"],
            "screenOutRisk": ts_metrics["screenOutRisk"],
            "concentrationRisk": ts_metrics["concentrationRisk"],
            "velocityRisk": ts_metrics["velocityRisk"],
            "pressureRisk": ts_metrics["pressureRisk"],
        })

    if successful_count == 0:
        print(
            "ERROR: All timesteps failed to parse -- no valid field data found",
            file=sys.stderr,
        )
        sys.exit(1)

    # Aggregate metrics from last timestep
    last_entry = time_series[-1]

    # predictedMaxTreatingPressure: max inletPressure across all timesteps
    # Convert from kinematic pressure (m²/s²) to psi: multiply by density (~1000 kg/m³)
    # then convert Pa to psi (1 Pa = 0.000145038 psi)
    max_inlet_pressure_kinematic = max(
        entry["pressureStats"]["inletPressure"] for entry in time_series
    )
    # kinematic pressure (m²/s²) × density (kg/m³) = Pa, then Pa → psi
    predicted_max_treating_pressure_psi = abs(max_inlet_pressure_kinematic) * 1000.0 * 0.000145038

    # Max screen-out risk across all timesteps
    max_screen_out_risk = max(entry["screenOutRisk"] for entry in time_series)

    residuals, iterations = parse_residuals(work_dir)

    # Use last timestep for cell count
    last_ts_dir = all_timesteps[-1][1]
    last_alpha = read_openfoam_field(last_ts_dir, "alpha.proppant")
    last_p = read_openfoam_field(last_ts_dir, "p")
    last_U = read_openfoam_field(last_ts_dir, "U")
    cell_count = 0
    if last_alpha is not None and last_p is not None and last_U is not None:
        cell_count = max(len(last_alpha), len(last_p), len(last_U))

    metrics = {
        "optimizationMetrics": {
            "proppantPlacementEfficiency": last_entry["proppantPlacementEfficiency"],
            "fractureGeometryScore": 0.0,  # Computed from last timestep below
            "placementUniformity": last_entry["placementUniformity"],
            "nearWellboreConcentration": 0.0,
        },
        "riskMetrics": {
            "screenOutRisk": max_screen_out_risk,
            "concentrationRisk": last_entry["concentrationRisk"],
            "velocityRisk": last_entry["velocityRisk"],
            "pressureRisk": last_entry["pressureRisk"],
        },
        "pressureStats": last_entry["pressureStats"],
        "simulationInfo": {
            "finalResiduals": residuals,
            "iterations": iterations,
            "cellCount": cell_count,
            "domainSize": domain_size,
        },
        "simulationParams": {
            "injectionRate": args.injection_rate,
            "proppantConcentration": args.proppant_concentration,
            "fluidViscosity": args.fluid_viscosity,
        },
        "predictedMaxTreatingPressure": round(predicted_max_treating_pressure_psi, 2),
        "timeSeries": time_series,
    }

    # Compute fracture geometry score and near-wellbore concentration from last timestep
    if last_alpha is not None and last_U is not None:
        if last_U.ndim == 1:
            last_U = last_U.reshape(1, -1)
        if len(last_alpha) == 1 and cell_count > 1:
            last_alpha = np.full(cell_count, last_alpha[0])
        if len(last_U) == 1 and cell_count > 1:
            last_U = np.tile(last_U[0], (cell_count, 1))
        metrics["optimizationMetrics"]["fractureGeometryScore"] = compute_fracture_geometry_score(last_U, domain_size)
        near_count = max(1, math.floor(cell_count * 0.1))
        metrics["optimizationMetrics"]["nearWellboreConcentration"] = round(float(np.mean(last_alpha[:near_count])), 6)

    return metrics


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv=None):
    args = parse_args(argv)
    work_dir = args.work_dir

    # --- Transient mode: process all timesteps ---
    if args.transient:
        metrics = compute_transient_metrics(work_dir, args)

        results_dir = os.path.join(work_dir, "results")
        os.makedirs(results_dir, exist_ok=True)
        output_path = os.path.join(results_dir, "metrics.json")
        with open(output_path, "w") as fh:
            json.dump(metrics, fh, indent=2)

        ts_count = len(metrics.get("timeSeries", []))
        print(f"Transient metrics written to {output_path} ({ts_count} timesteps)")
        return metrics

    # --- Steady-state mode: process latest timestep only ---
    timestep_dir = find_latest_timestep(work_dir)
    if timestep_dir is None:
        print(
            f"ERROR: No OpenFOAM timestep directories found in {work_dir}",
            file=sys.stderr,
        )
        sys.exit(1)

    # --- Read fields ---
    alpha = read_openfoam_field(timestep_dir, "alpha.proppant")
    if alpha is None:
        print(
            f"ERROR: Failed to read field alpha.proppant from {timestep_dir}",
            file=sys.stderr,
        )
        sys.exit(1)

    U = read_openfoam_field(timestep_dir, "U")
    if U is None:
        print(
            f"ERROR: Failed to read field U from {timestep_dir}",
            file=sys.stderr,
        )
        sys.exit(1)
    # Ensure U is 2-D (N, 3)
    if U.ndim == 1:
        U = U.reshape(1, -1)

    p = read_openfoam_field(timestep_dir, "p")
    if p is None:
        print(
            f"ERROR: Failed to read field p from {timestep_dir}",
            file=sys.stderr,
        )
        sys.exit(1)

    # --- Expand uniform fields to match the mesh cell count ---
    # OpenFOAM writes "internalField uniform <value>" when all cells have the
    # same value.  The parser returns a single-element array in that case.
    # Expand it to the actual cell count so downstream metrics (cellCount,
    # placement uniformity, etc.) reflect the real mesh resolution.
    cell_count = max(len(alpha), len(p), len(U))
    if len(alpha) == 1 and cell_count > 1:
        alpha = np.full(cell_count, alpha[0])
    if len(p) == 1 and cell_count > 1:
        p = np.full(cell_count, p[0])
    if len(U) == 1 and cell_count > 1:
        U = np.tile(U[0], (cell_count, 1))


    # --- Domain size ---
    domain_size = detect_domain_size(work_dir)

    # --- Validate cell count against expected mesh ---
    validate_cell_count(cell_count, domain_size)

    # --- Residuals from solver log ---
    residuals, iterations = parse_residuals(work_dir)

    # --- Assemble metrics ---
    metrics = assemble_metrics(
        alpha=alpha,
        U=U,
        p=p,
        domain_size=domain_size,
        residuals=residuals,
        iterations=iterations,
        injection_rate=args.injection_rate,
        proppant_concentration=args.proppant_concentration,
        fluid_viscosity=args.fluid_viscosity,
    )

    # --- Write output ---
    results_dir = os.path.join(work_dir, "results")
    os.makedirs(results_dir, exist_ok=True)
    output_path = os.path.join(results_dir, "metrics.json")
    with open(output_path, "w") as fh:
        json.dump(metrics, fh, indent=2)

    print(f"Metrics written to {output_path}")
    return metrics


if __name__ == "__main__":
    main()
