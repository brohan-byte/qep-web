#!/usr/bin/env julia

using HTTP
using JSON3

const WEB_DIR = @__DIR__
const PROJECT_DIR = normpath(joinpath(@__DIR__, ".."))
const INDEX_FILE = joinpath(PROJECT_DIR, "web_export", "web_index.json")
const ANALYTICS_DIR = joinpath(PROJECT_DIR, "results", "database", "analytics")

const HOST = get(ENV, "WEB_HOST", "0.0.0.0")
const PORT = parse(Int, get(ENV, "PORT", get(ENV, "WEB_PORT", "8080")))

const CONTINUOUS_FIELDS = (:network_fidelity, :total_2q_error, :measurement_flip, :idle_lambda1, :idle_lambda2)
const PHYSICAL_LB = (0.60, 0.00, 0.00, 0.00, 0.00)
const PHYSICAL_UB = (0.99, 0.20, 0.30, 0.10, 0.10)
const DISTANCE_WEIGHTS = (2.0, 3.0, 2.0, 1.0, 1.0, 1.0, 1.0)
const DISTANCE_WARNING_THRESHOLD = 0.25

const POINTS = Ref(Vector{Any}())
const STRATA = Ref(Dict{Tuple,Vector{Any}}())

stratum_key(p) = (Int(p.number_registers), Int(p.purified_pairs), String(p.evolution_metric), Int(p.code_distance))

function rebuild_strata!()
    strata = Dict{Tuple,Vector{Any}}()
    for p in POINTS[]
        push!(get!(strata, stratum_key(p), Any[]), p)
    end
    STRATA[] = strata
    length(strata)
end

function load_index!()
    isfile(INDEX_FILE) || error("Web index does not exist: $INDEX_FILE\nRun export_web_database.jl on Unity first.")
    POINTS[] = collect(JSON3.read(read(INDEX_FILE, String)))
    n = rebuild_strata!()
    println("Loaded ", length(POINTS[]), " web points across ", n, " strata")
end

function normalize_biases(bx::Real, by::Real, bz::Real)
    b = Float64[bx, by, bz]
    all(isfinite, b) || throw(ArgumentError("Pauli bias values must be finite"))
    all(x -> x >= 0.0, b) || throw(ArgumentError("Pauli bias values must be non-negative"))
    s = sum(b)
    s > 0 || throw(ArgumentError("At least one Pauli bias must be greater than zero"))
    (b[1]/s, b[2]/s, b[3]/s)
end

function normalize_physical(field::Symbol, value::Real)
    idx = findfirst(==(field), CONTINUOUS_FIELDS)
    isnothing(idx) && error("Unknown continuous field: $field")
    (Float64(value) - PHYSICAL_LB[idx]) / (PHYSICAL_UB[idx] - PHYSICAL_LB[idx])
end

bias_to_2d(bx, by, bz) = (Float64(by) + 0.5*Float64(bz), (sqrt(3)/2)*Float64(bz))

function environment_vector(; network_fidelity, total_2q_error, measurement_flip, idle_lambda1, idle_lambda2, bias_x, bias_y, bias_z)
    bu, bv = bias_to_2d(bias_x, bias_y, bias_z)
    (
        normalize_physical(:network_fidelity, network_fidelity),
        normalize_physical(:total_2q_error, total_2q_error),
        normalize_physical(:measurement_flip, measurement_flip),
        normalize_physical(:idle_lambda1, idle_lambda1),
        normalize_physical(:idle_lambda2, idle_lambda2),
        bu,
        bv,
    )
end

point_environment_vector(p) = environment_vector(
    network_fidelity=p.network_fidelity,
    total_2q_error=p.total_2q_error,
    measurement_flip=p.measurement_flip,
    idle_lambda1=p.idle_lambda1,
    idle_lambda2=p.idle_lambda2,
    bias_x=p.bias_x,
    bias_y=p.bias_y,
    bias_z=p.bias_z,
)

weighted_distance(a, b) = sqrt(sum(DISTANCE_WEIGHTS[i] * (Float64(a[i])-Float64(b[i]))^2 for i in eachindex(a)))

function validate_physical(values)
    for (i, field) in enumerate(CONTINUOUS_FIELDS)
        v = Float64(values[i])
        lb, ub = PHYSICAL_LB[i], PHYSICAL_UB[i]
        lb <= v <= ub || throw(ArgumentError("$field=$v is outside env_v1 bounds [$lb, $ub]"))
    end
end

function query_nearest(body)
    nr = Int(body.number_registers)
    pp = Int(body.purified_pairs)
    metric = String(body.evolution_metric)
    code_distance = Int(body.code_distance)

    nr >= 2 || throw(ArgumentError("number_registers must be >= 2"))
    pp >= 1 || throw(ArgumentError("purified_pairs must be >= 1"))
    pp <= nr || throw(ArgumentError("purified_pairs=$pp cannot exceed number_registers=$nr"))

    network_fidelity = Float64(body.network_fidelity)
    total_2q_error = Float64(body.total_2q_error)
    measurement_flip = Float64(body.measurement_flip)
    idle_lambda1 = Float64(body.idle_lambda1)
    idle_lambda2 = Float64(body.idle_lambda2)
    validate_physical((network_fidelity, total_2q_error, measurement_flip, idle_lambda1, idle_lambda2))

    bias_x, bias_y, bias_z = normalize_biases(Float64(body.bias_x), Float64(body.bias_y), Float64(body.bias_z))

    candidates = get(STRATA[], (nr, pp, metric, code_distance), nothing)
    isnothing(candidates) && error("No exported database points match the requested resource stratum")

    q = environment_vector(
        network_fidelity=network_fidelity,
        total_2q_error=total_2q_error,
        measurement_flip=measurement_flip,
        idle_lambda1=idle_lambda1,
        idle_lambda2=idle_lambda2,
        bias_x=bias_x,
        bias_y=bias_y,
        bias_z=bias_z,
    )

    best = nothing
    best_distance = Inf
    for p in candidates
        d = weighted_distance(q, point_environment_vector(p))
        if d < best_distance
            best, best_distance = p, d
        end
    end

    warning = best_distance > DISTANCE_WARNING_THRESHOLD ?
        "Nearest database environment has normalized distance=$(round(best_distance,digits=4)), above the current baseline warning threshold $(DISTANCE_WARNING_THRESHOLD)." : nothing

    requested = (
        network_fidelity=network_fidelity,
        total_2q_error=total_2q_error,
        measurement_flip=measurement_flip,
        idle_lambda1=idle_lambda1,
        idle_lambda2=idle_lambda2,
        bias_x=bias_x,
        bias_y=bias_y,
        bias_z=bias_z,
    )

    matched = (
        network_fidelity=Float64(best.network_fidelity),
        total_2q_error=Float64(best.total_2q_error),
        measurement_flip=Float64(best.measurement_flip),
        idle_lambda1=Float64(best.idle_lambda1),
        idle_lambda2=Float64(best.idle_lambda2),
        bias_x=Float64(best.bias_x),
        bias_y=Float64(best.bias_y),
        bias_z=Float64(best.bias_z),
    )

    performance = (
        logical_qubit_fidelity=best.logical_qubit_fidelity,
        purified_pairs_fidelity=best.purified_pairs_fidelity,
        average_marginal_fidelity=best.average_marginal_fidelity,
        success_probability=best.success_probability,
    )

    assets = (
        circuit_image=best.circuit_image,
        history_image=best.history_image,
        fin_fout_image=best.fin_fout_image,
    )

    (
        task_id=Int(best.task_id),
        sobol_index=Int(best.sobol_index),
        id_string=String(best.id_string),
        seed=Int(best.seed),
        number_registers=Int(best.number_registers),
        purified_pairs=Int(best.purified_pairs),
        evolution_metric=String(best.evolution_metric),
        code_distance=Int(best.code_distance),
        distance=best_distance,
        warning=warning,
        circuit_length=Int(best.circuit_length),
        circuit_ops=collect(best.circuit_ops),
        performance=performance,
        reliable=best.reliable,
        requested=requested,
        matched=matched,
        assets=assets,
    )
end

json_response(data; status=200) = HTTP.Response(status, ["Content-Type"=>"application/json; charset=utf-8", "Cache-Control"=>"no-store"], JSON3.write(data))

function content_type(path)
    get(Dict(".html"=>"text/html; charset=utf-8", ".css"=>"text/css; charset=utf-8", ".js"=>"application/javascript; charset=utf-8", ".png"=>"image/png", ".svg"=>"image/svg+xml"), lowercase(splitext(path)[2]), "application/octet-stream")
end

function serve_file(path; cache=true)
    isfile(path) || return HTTP.Response(404, "Not found")
    HTTP.Response(200, ["Content-Type"=>content_type(path), "Cache-Control"=>(cache ? "public, max-age=3600" : "no-store")], read(path))
end

function safe_asset_path(relative)
    root = normpath(ANALYTICS_DIR)
    path = normpath(joinpath(root, relative))
    rel = relpath(path, root)
    (startswith(rel, "..") || isabspath(rel)) && return nothing
    path
end

function router(req)
    uri = HTTP.URI(req.target)
    path = uri.path
    println("REQUEST: ", req.method, " ", path)
    if req.method == "GET" && path == "/health"
        return HTTP.Response(
            200,
            ["Content-Type" => "text/plain"],
            "ok",
    )
    elseif req.method == "GET" && path == "/"
        return serve_file(joinpath(WEB_DIR, "index.html"); cache=false)
    elseif req.method == "GET" && path == "/app.js"
        return serve_file(joinpath(WEB_DIR, "app.js"); cache=false)
    elseif req.method == "GET" && path == "/styles.css"
        return serve_file(joinpath(WEB_DIR, "styles.css"); cache=false)
    elseif req.method == "POST" && path == "/api/query"
        try
            return json_response(query_nearest(JSON3.read(String(req.body))))
        catch e
            @error "Query failed" exception=(e, catch_backtrace())
            return json_response((error=sprint(showerror,e),); status=400)
        end
    elseif req.method == "POST" && path == "/api/reload"
        try
            load_index!()
            return json_response((points=length(POINTS[]), strata=length(STRATA[])))
        catch e
            return json_response((error=sprint(showerror,e),); status=500)
        end
    elseif req.method == "GET" && startswith(path, "/assets/")
        relative = path[length("/assets/")+1:end]
        asset_path = safe_asset_path(relative)
        isnothing(asset_path) && return HTTP.Response(403, "Forbidden")
        return serve_file(asset_path)
    end

    HTTP.Response(404, "Not found")
end

load_index!()
println("QEP lightweight web server: http://$(HOST):$(PORT)")
println("Web points: ", length(POINTS[]))
println("Strata:     ", length(STRATA[]))
println("WEB_DIR = ", WEB_DIR)
println(
    "index.html exists = ",
    isfile(joinpath(WEB_DIR, "index.html"))
)
println(
    "app.js exists = ",
    isfile(joinpath(WEB_DIR, "app.js"))
)
println(
    "styles.css exists = ",
    isfile(joinpath(WEB_DIR, "styles.css"))
)

HTTP.serve(router, HOST, PORT)
