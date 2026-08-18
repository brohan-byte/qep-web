#!/usr/bin/env julia

using Serialization
using JSON3
using QEPOptimize
import BPGates
import QuantumClifford

const POINTS_DIR = joinpath(@__DIR__, "results", "database", "points")
const ANALYTICS_DIR = joinpath(@__DIR__, "results", "database", "analytics")
const OUTPUT_DIR = joinpath(@__DIR__, "web_export")
const OUTPUT_FILE = joinpath(OUTPUT_DIR, "web_index.json")
mkpath(OUTPUT_DIR)

function env_bool(name, default=false)
    lowercase(get(ENV, name, default ? "1" : "0")) in ("1", "true", "yes", "y")
end

function export_limit()
    raw = strip(get(ENV, "WEB_EXPORT_LIMIT", ""))
    isempty(raw) && return nothing
    n = tryparse(Int, raw)
    isnothing(n) && error("Invalid WEB_EXPORT_LIMIT=$raw")
    n >= 1 || error("WEB_EXPORT_LIMIT must be >= 1")
    n
end

const REQUIRE_CIRCUIT = env_bool("WEB_REQUIRE_CIRCUIT")
const REQUIRE_HISTORY = env_bool("WEB_REQUIRE_HISTORY")
const REQUIRE_FIN_FOUT = env_bool("WEB_REQUIRE_FIN_FOUT")
const EXPORT_LIMIT = export_limit()

safe_filename(id) = replace(String(id), r"[^A-Za-z0-9_.\-]" => "_")
getprop_or(x, name::Symbol, default=nothing) = hasproperty(x, name) ? getproperty(x, name) : default
config_value(cfg, name::Symbol, default=nothing) = hasproperty(cfg, name) ? getproperty(cfg, name) : default

function performance_value(perf, name::Symbol)
    (isnothing(perf) || ismissing(perf) || !hasproperty(perf, name)) && return nothing
    getproperty(perf, name)
end

function saved_performance(saved)
    hasproperty(saved, :final_performance) && return saved.final_performance
    hasproperty(saved, :raw_performance) && return saved.raw_performance
    nothing
end

function asset_info(id_string)
    id = safe_filename(id_string)
    circuit_path = joinpath(ANALYTICS_DIR, "circuits", id * ".png")
    history_path = joinpath(ANALYTICS_DIR, "history", id * ".png")
    fin_fout_path = joinpath(ANALYTICS_DIR, "fin_fout", "plots", id * ".png")
    (
        has_circuit = isfile(circuit_path),
        has_history = isfile(history_path),
        has_fin_fout = isfile(fin_fout_path),
        circuit_image = isfile(circuit_path) ? "/assets/circuits/$(id).png" : nothing,
        history_image = isfile(history_path) ? "/assets/history/$(id).png" : nothing,
        fin_fout_image = isfile(fin_fout_path) ? "/assets/fin_fout/plots/$(id).png" : nothing,
    )
end

function point_is_usable(a)
    REQUIRE_CIRCUIT && !a.has_circuit && return false
    REQUIRE_HISTORY && !a.has_history && return false
    REQUIRE_FIN_FOUT && !a.has_fin_fout && return false
    true
end

function export_point(path)
    id_string = splitext(basename(path))[1]
    assets = asset_info(id_string)
    point_is_usable(assets) || return nothing

    saved = deserialize(path)
    hasproperty(saved, :config) || error("$id_string has no config field")
    cfg = saved.config
    perf = saved_performance(saved)
    circuit = saved.best_circuit
    ops = string.(circuit.ops)
    len = hasproperty(saved, :best_circuit_length) ? Int(saved.best_circuit_length) : length(ops)

    (
        id_string = id_string,
        task_id = Int(config_value(cfg, :task_id)),
        sobol_index = Int(config_value(cfg, :sobol_index)),
        seed = Int(config_value(cfg, :seed, 1)),
        environment_space = String(config_value(cfg, :environment_space, "env_v1")),
        number_registers = Int(config_value(cfg, :number_registers)),
        purified_pairs = Int(config_value(cfg, :purified_pairs)),
        evolution_metric = String(config_value(cfg, :evolution_metric, "logical_qubit_fidelity")),
        code_distance = Int(config_value(cfg, :code_distance, 1)),
        network_fidelity = Float64(config_value(cfg, :network_fidelity)),
        total_2q_error = Float64(config_value(cfg, :total_2q_error)),
        measurement_flip = Float64(config_value(cfg, :measurement_flip)),
        idle_lambda1 = Float64(config_value(cfg, :idle_lambda1)),
        idle_lambda2 = Float64(config_value(cfg, :idle_lambda2)),
        bias_x = Float64(config_value(cfg, :bias_x)),
        bias_y = Float64(config_value(cfg, :bias_y)),
        bias_z = Float64(config_value(cfg, :bias_z)),
        circuit_length = len,
        circuit_ops = ops,
        logical_qubit_fidelity = performance_value(perf, :logical_qubit_fidelity),
        purified_pairs_fidelity = performance_value(perf, :purified_pairs_fidelity),
        average_marginal_fidelity = performance_value(perf, :average_marginal_fidelity),
        success_probability = performance_value(perf, :success_probability),
        reliable = getprop_or(saved, :reliable, nothing),
        circuit_image = assets.circuit_image,
        history_image = assets.history_image,
        fin_fout_image = assets.fin_fout_image,
    )
end

representative_key(p) = (
    p.environment_space,
    p.number_registers,
    p.purified_pairs,
    p.evolution_metric,
    p.code_distance,
    p.sobol_index,
)

function collapse_seed_replicates(points)
    chosen = Dict{Any,Any}()
    for p in points
        key = representative_key(p)
        if !haskey(chosen, key)
            chosen[key] = p
            continue
        end
        current = chosen[key]
        if p.seed == 1 && current.seed != 1
            chosen[key] = p
        elseif current.seed != 1 && p.seed < current.seed
            chosen[key] = p
        end
    end
    collect(values(chosen))
end

function main()
    isdir(POINTS_DIR) || error("Points directory does not exist: $POINTS_DIR")
    files = sort(filter(f -> endswith(f, ".jls"), readdir(POINTS_DIR; join=true)))

    println("="^72)
    println("EXPORTING LIGHTWEIGHT WEB DATABASE")
    println("Completed .jls files:   ", length(files))
    println("Require circuit PNG:    ", REQUIRE_CIRCUIT)
    println("Require history PNG:    ", REQUIRE_HISTORY)
    println("Require F-in/F-out PNG: ", REQUIRE_FIN_FOUT)
    println("Export limit:            ", isnothing(EXPORT_LIMIT) ? "none" : EXPORT_LIMIT)
    println("Output:                  ", OUTPUT_FILE)
    println("="^72)

    raw_points = Any[]
    failed = 0
    skipped = 0

    for (i, path) in enumerate(files)
        try
            p = export_point(path)
            if isnothing(p)
                skipped += 1
            else
                push!(raw_points, p)
            end
        catch e
            failed += 1
            @warn "Could not export $(basename(path))" exception=(e, catch_backtrace())
        end

        if i % 1000 == 0 || i == length(files)
            println("scanned=$i/$(length(files)) usable=$(length(raw_points)) skipped=$skipped failed=$failed")
        end
    end

    points = collapse_seed_replicates(raw_points)
    sort!(points; by=p -> (p.number_registers, p.purified_pairs, p.evolution_metric, p.code_distance, p.sobol_index, p.seed))

    if !isnothing(EXPORT_LIMIT)
        points = points[1:min(EXPORT_LIMIT, length(points))]
    end

    open(OUTPUT_FILE, "w") do io
        JSON3.write(io, points)
    end

    println("="^72)
    println("DONE")
    println("Representative web points: ", length(points))
    println("Skipped by asset policy:    ", skipped)
    println("Failed exports:              ", failed)
    println("Written:                     ", OUTPUT_FILE)
end

main()
