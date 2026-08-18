using HTTP
using JSON3

# Use the exact database NN controller.
include(joinpath(@__DIR__, "..", "query_nearest_circuit.jl"))

const WEB_DIR = @__DIR__

const ANALYTICS_DIR = joinpath(
    @__DIR__,
    "..",
    "results",
    "database",
    "analytics",
)

const HOST = get(ENV, "WEB_HOST", "0.0.0.0")
const PORT = parse(
    Int,
    get(
        ENV,
        "PORT",
        "8080",
    ),
)

# query_nearest_circuit.jl caches the manifest and tracks completed .jls files.
load_manifest()
refresh_completed_ids!()


function json_response(data; status=200)
    HTTP.Response(
        status,
        [
            "Content-Type" => "application/json; charset=utf-8",
            "Cache-Control" => "no-store",
        ],
        JSON3.write(data),
    )
end


function content_type(path::AbstractString)
    ext = lowercase(splitext(path)[2])

    get(
        Dict(
            ".html" => "text/html; charset=utf-8",
            ".css"  => "text/css; charset=utf-8",
            ".js"   => "application/javascript; charset=utf-8",
            ".png"  => "image/png",
            ".svg"  => "image/svg+xml",
            ".json" => "application/json; charset=utf-8",
        ),
        ext,
        "application/octet-stream",
    )
end


function serve_file(path::AbstractString; cache=true)
    isfile(path) || return HTTP.Response(404, "Not found")

    headers = [
        "Content-Type" => content_type(path),
        "Cache-Control" => cache ? "public, max-age=3600" : "no-store",
    ]

    HTTP.Response(200, headers, read(path))
end


# Must match precompute_analytics.jl.
function safe_filename(id_string)
    replace(
        String(id_string),
        r"[^A-Za-z0-9_.\-]" => "_",
    )
end


function artifact_urls(id_string)
    id = safe_filename(id_string)

    circuit_path = joinpath(
        ANALYTICS_DIR,
        "circuits",
        id * ".png",
    )

    history_path = joinpath(
        ANALYTICS_DIR,
        "history",
        id * ".png",
    )

    fin_fout_path = joinpath(
        ANALYTICS_DIR,
        "fin_fout",
        "plots",
        id * ".png",
    )

    return (
        circuit_image = isfile(circuit_path) ?
            "/assets/circuits/$(id).png" : nothing,

        history_image = isfile(history_path) ?
            "/assets/history/$(id).png" : nothing,

        fin_fout_image = isfile(fin_fout_path) ?
            "/assets/fin_fout/plots/$(id).png" : nothing,
    )
end


function performance_json(perf)
    if ismissing(perf) || isnothing(perf)
        return nothing
    end

    return (
        logical_qubit_fidelity =
            perf.logical_qubit_fidelity,

        purified_pairs_fidelity =
            perf.purified_pairs_fidelity,

        average_marginal_fidelity =
            perf.average_marginal_fidelity,

        success_probability =
            perf.success_probability,
    )
end


function handle_query(req)
    try
        body = JSON3.read(String(req.body))

        # IMPORTANT:
        # All actual nearest-neighbor selection is delegated to
        # query_nearest_circuit.jl.
        result = query_nearest(
            ;
            number_registers =
                Int(body.number_registers),

            purified_pairs =
                Int(body.purified_pairs),

            evolution_metric =
                Symbol(String(body.evolution_metric)),

            code_distance =
                Int(body.code_distance),

            network_fidelity =
                Float64(body.network_fidelity),

            total_2q_error =
                Float64(body.total_2q_error),

            measurement_flip =
                Float64(body.measurement_flip),

            idle_lambda1 =
                Float64(body.idle_lambda1),

            idle_lambda2 =
                Float64(body.idle_lambda2),

            bias_x =
                Float64(body.bias_x),

            bias_y =
                Float64(body.bias_y),

            bias_z =
                Float64(body.bias_z),
        )

        assets = artifact_urls(
            result.match_id_string
        )

        response = (
            task_id =
                result.task_id,

            sobol_index =
                result.sobol_index,

            id_string =
                result.match_id_string,

            seed =
                result.seed,

            number_registers =
                result.number_registers,

            purified_pairs =
                result.purified_pairs,

            evolution_metric =
                String(result.evolution_metric),

            code_distance =
                result.code_distance,

            distance =
                result.distance,

            warning =
                result.warning,

            circuit_length =
                result.circuit_length,
            circuit_ops =

    string.(result.circuit.ops),
            performance =
                performance_json(
                    result.database_performance
                ),

            reliable =
                result.reliable,

            requested =
                result.query_condition,

            matched =
                result.matched_condition,

            assets =
                assets,
        )

        return json_response(response)

    catch e
        @error "Query failed" exception=(e, catch_backtrace())

        return json_response(
            (
                error = sprint(showerror, e),
            );
            status=400,
        )
    end
end


function safe_asset_path(relative::AbstractString)
    root = normpath(ANALYTICS_DIR)
    path = normpath(joinpath(root, relative))

    rel = relpath(path, root)

    if startswith(rel, "..") || isabspath(rel)
        return nothing
    end

    return path
end


function router(req)
    uri = HTTP.URI(req.target)
    path = uri.path

    if req.method == "GET" && path == "/"
        return serve_file(
            joinpath(WEB_DIR, "index.html");
            cache=false,
        )

    elseif req.method == "GET" && path == "/app.js"
        return serve_file(
            joinpath(WEB_DIR, "app.js");
            cache=false,
        )

    elseif req.method == "GET" && path == "/styles.css"
        return serve_file(
            joinpath(WEB_DIR, "styles.css");
            cache=false,
        )

    elseif req.method == "POST" && path == "/api/query"
        return handle_query(req)

    elseif req.method == "POST" && path == "/api/refresh"
        reload_manifest!()
        n = refresh_completed_ids!()

        return json_response(
            (
                completed_points = n,
            )
        )

    elseif req.method == "GET" && startswith(path, "/assets/")
        relative = path[length("/assets/") + 1:end]
        asset_path = safe_asset_path(relative)

        isnothing(asset_path) &&
            return HTTP.Response(403, "Forbidden")

        return serve_file(asset_path)
    end

    return HTTP.Response(404, "Not found")
end


println("Starting QEP circuit controller")
println("http://$(HOST):$(PORT)")
println("Completed database points: ", length(COMPLETED_IDS[]))
println("Analytics root: ", ANALYTICS_DIR)

HTTP.serve(
    router,
    HOST,
    PORT,
)
