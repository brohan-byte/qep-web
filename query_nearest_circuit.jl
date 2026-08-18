# query_nearest_circuit.jl
#
# Baseline nearest-neighbor controller for the QEPOptimize circuit database.
#
# Workflow:
#
#   user query
#       ↓
#   exact discrete resource-stratum match
#       ↓
#   keep only COMPLETED database points
#       ↓
#   collapse multiple GA seeds at the same Sobol environment
#       ↓
#   normalized 7-D nearest-neighbor search
#       ↓
#   load only the winning .jls result(s)
#
#
# Example:
#
# result = query_nearest(;
#     number_registers = 6,
#     purified_pairs = 2,
#     evolution_metric = :logical_qubit_fidelity,
#     code_distance = 1,
#
#     network_fidelity = 0.91,
#     total_2q_error = 0.03,
#     measurement_flip = 0.01,
#     idle_lambda1 = 0.02,
#     idle_lambda2 = 0.01,
#
#     bias_x = 1/3,
#     bias_y = 1/3,
#     bias_z = 1/3,
# )
#
#
# Important:
#
# result.database_performance
#
# is the saved performance at the MATCHED database environment.
#
# It is NOT yet a fresh evaluation of the returned circuit at the exact
# user query. Query-time re-evaluation/reranking can be added later.


using CSV
using DataFrames
using Serialization

using QEPOptimize: Population,
                   NetworkFidelity

# Required before deserializing saved database points.
using QEPOptimize
import BPGates
import QuantumClifford
# ==========================================================================
# Paths
# ==========================================================================

const MANIFEST = joinpath(
    @__DIR__,
    "configs",
    "database_configs_manifest.csv",
)

const POINTS_DIR = joinpath(
    @__DIR__,
    "results",
    "database",
    "points",
)


# Cache of database points that have actually finished generating.
const COMPLETED_IDS = Ref{Set{String}}(Set{String}())

function refresh_completed_ids!()
    COMPLETED_IDS[] = Set(
        splitext(f)[1]
        for f in readdir(POINTS_DIR)
        if endswith(f, ".jls")
    )

    return length(COMPLETED_IDS[])
end
# ==========================================================================
# Environment-space definition
#
# MUST remain identical to generate_database_configs.jl for env_v1.
# ==========================================================================

const CONTINUOUS_FIELDS = (
    :network_fidelity,
    :total_2q_error,
    :measurement_flip,
    :idle_lambda1,
    :idle_lambda2,
)

const PHYSICAL_LB = (
    0.60,   # network_fidelity
    0.00,   # total_2q_error
    0.00,   # measurement_flip
    0.00,   # idle_lambda1
    0.00,   # idle_lambda2
)

const PHYSICAL_UB = (
    0.99,
    0.20,
    0.30,
    0.10,
    0.10,
)
const DISTANCE_WEIGHTS = (
    2.0,   # network fidelity
    3.0,   # 2Q error
    2.0,   # measurement
    1.0,   # T1
    1.0,   # T2
    1.0,   # bias coord 1
    1.0,   # bias coord 2
)

# ==========================================================================
# Distance warning
#
# This is intentionally just a baseline threshold.
#
# Later you should calibrate this from empirical nearest-neighbor distance
# percentiles rather than treating this number as intrinsically meaningful.
# ==========================================================================

const DISTANCE_WARNING_THRESHOLD = 0.25


# ==========================================================================
# Manifest cache
#
# Loading a ~270k-row CSV for every web/API query is unnecessary.
# ==========================================================================

const MANIFEST_CACHE = Ref{Union{Nothing,DataFrame}}(nothing)


function load_manifest(; force_reload::Bool = false)

    if force_reload || isnothing(MANIFEST_CACHE[])

        isfile(MANIFEST) || error(
            "Database manifest does not exist:\n$MANIFEST"
        )

        MANIFEST_CACHE[] = CSV.read(
            MANIFEST,
            DataFrame,
        )

        refresh_completed_ids!()
    end

    return MANIFEST_CACHE[]
end

"""
Reload the manifest after extending the database while using the same
long-running Julia process.
"""
function reload_manifest!()
    MANIFEST_CACHE[] = nothing
    return load_manifest(force_reload = true)
end


# ==========================================================================
# Normalization helpers
# ==========================================================================

"""
Normalize one physical continuous dimension to [0,1] using the exact
generation-space bounds.
"""
function normalize_physical(
    field::Symbol,
    value::Real,
)

    idx = findfirst(
        ==(field),
        CONTINUOUS_FIELDS,
    )

    isnothing(idx) && error(
        "Unknown continuous field: $field"
    )

    lb = PHYSICAL_LB[idx]
    ub = PHYSICAL_UB[idx]

    return (Float64(value) - lb) / (ub - lb)
end


# ==========================================================================
# Bias simplex representation
#
# bx + by + bz = 1, so bias has only TWO independent dimensions.
#
# Instead of treating (bx,by,bz) as three independent dimensions, map the
# simplex to an equilateral 2-D triangle:
#
#             z
#            / \
#           /   \
#          x-----y
#
# This treats X/Y/Z symmetrically and gives us:
#
#   5 normalized physical dimensions
# + 2 bias dimensions
# = 7 independent dimensions
#
# matching the dimensionality of the generated environment.
# ==========================================================================

function bias_to_2d(
    bx::Real,
    by::Real,
    bz::Real,
)

    bx = Float64(bx)
    by = Float64(by)
    bz = Float64(bz)

    # Triangle vertices:
    #
    # X = (0,0)
    # Y = (1,0)
    # Z = (1/2, sqrt(3)/2)

    u = by + 0.5 * bz
    v = (sqrt(3) / 2) * bz

    return (u, v)
end

# ==========================================================================
# Bias normalization
#
# API/web users may provide approximate fractions or relative weights.
#
# Examples:
#
#     0.30, 0.30, 0.38
#
# or:
#
#     1, 2, 1
#
# Both are normalized automatically.
#
# The database itself continues to store normalized bias fractions.
# ==========================================================================

function normalize_biases(
    bias_x::Real,
    bias_y::Real,
    bias_z::Real,
)

    biases = Float64[
        bias_x,
        bias_y,
        bias_z,
    ]


    all(isfinite, biases) || throw(
        ArgumentError(
            "bias_x, bias_y, and bias_z must all be finite"
        )
    )


    all(b -> b >= 0.0, biases) || throw(
        ArgumentError(
            "bias_x, bias_y, and bias_z must all be non-negative"
        )
    )


    bias_sum =
        sum(biases)


    bias_sum > 0.0 || throw(
        ArgumentError(
            "At least one Pauli bias must be greater than zero"
        )
    )


    return (
        biases[1] / bias_sum,
        biases[2] / bias_sum,
        biases[3] / bias_sum,
    )
end
# ==========================================================================
# Input validation
# ==========================================================================

function validate_query(
    ;
    number_registers,
    purified_pairs,
    network_fidelity,
    total_2q_error,
    measurement_flip,
    idle_lambda1,
    idle_lambda2,
    bias_x,
    bias_y,
    bias_z,
)

    number_registers >= 2 || throw(
        ArgumentError(
            "number_registers must be >= 2"
        )
    )

    purified_pairs >= 1 || throw(
        ArgumentError(
            "purified_pairs must be >= 1"
        )
    )

    purified_pairs <= number_registers || throw(
        ArgumentError(
            "purified_pairs=$purified_pairs cannot exceed " *
            "number_registers=$number_registers"
        )
    )

    values = (
        network_fidelity,
        total_2q_error,
        measurement_flip,
        idle_lambda1,
        idle_lambda2,
    )

    for (i, field) in enumerate(CONTINUOUS_FIELDS)

        value = Float64(values[i])
        lb = PHYSICAL_LB[i]
        ub = PHYSICAL_UB[i]

        lb <= value <= ub || throw(
            ArgumentError(
                "$field=$value is outside env_v1 bounds [$lb, $ub]"
            )
        )
    end

    biases = Float64[
        bias_x,
        bias_y,
        bias_z,
    ]

    all(b -> b >= 0.0, biases) || throw(
        ArgumentError(
            "bias_x, bias_y, and bias_z must all be non-negative"
        )
    )

    bias_sum = sum(biases)
    isapprox(

    bias_sum,

    1.0;

    atol = 1e-8,

    rtol = 1e-8,

) || throw(

    ArgumentError(

        "Pauli biases must sum to 1.0; got $bias_sum"

    )

)
    isapprox(
        bias_sum,
        1.0;
        atol = 1e-8,
        rtol = 1e-8,
    ) || throw(
        ArgumentError(
            "Pauli biases must sum to 1.0; got $bias_sum"
        )
    )

    return nothing
end


# ==========================================================================
# Environment vectors
# ==========================================================================

"""
Create the normalized independent 7-D representation of a user query.
"""
function query_environment_vector(
    ;
    network_fidelity,
    total_2q_error,
    measurement_flip,
    idle_lambda1,
    idle_lambda2,
    bias_x,
    bias_y,
    bias_z,
)

    bu, bv = bias_to_2d(
        bias_x,
        bias_y,
        bias_z,
    )

    return (
        normalize_physical(
            :network_fidelity,
            network_fidelity,
        ),

        normalize_physical(
            :total_2q_error,
            total_2q_error,
        ),

        normalize_physical(
            :measurement_flip,
            measurement_flip,
        ),

        normalize_physical(
            :idle_lambda1,
            idle_lambda1,
        ),

        normalize_physical(
            :idle_lambda2,
            idle_lambda2,
        ),

        bu,
        bv,
    )
end


"""
Create the same normalized 7-D representation for a manifest row.
"""
function row_environment_vector(row)

    bu, bv = bias_to_2d(
        row.bias_x,
        row.bias_y,
        row.bias_z,
    )

    return (
        normalize_physical(
            :network_fidelity,
            row.network_fidelity,
        ),

        normalize_physical(
            :total_2q_error,
            row.total_2q_error,
        ),

        normalize_physical(
            :measurement_flip,
            row.measurement_flip,
        ),

        normalize_physical(
            :idle_lambda1,
            row.idle_lambda1,
        ),

        normalize_physical(
            :idle_lambda2,
            row.idle_lambda2,
        ),

        bu,
        bv,
    )
end


function euclidean_distance(a, b)

    @assert length(a) == length(b)

    return sqrt(
        sum(
            (Float64(a[i]) - Float64(b[i]))^2
            for i in eachindex(a)
        )
    )
end
function weighted_distance(a, b)
    return sqrt(
        sum(
            DISTANCE_WEIGHTS[i] *
            (Float64(a[i]) - Float64(b[i]))^2
            for i in eachindex(a)
        )
    )
end

# ==========================================================================
# Completed-point helpers
# ==========================================================================

function result_path(id_string)

    return joinpath(
        POINTS_DIR,
        String(id_string) * ".jls",
    )
end

function result_exists(row)
    return String(row.id_string) in COMPLETED_IDS[]
end


# ==========================================================================
# Seed replicate collapsing
#
# If reseeding creates:
#
#   same resource
#   same Sobol
#   same metric
#   same distance
#   seed=1
#   seed=2
#   seed=3
#
# those represent ONE environmental location for NN purposes.
#
# Baseline policy:
#   prefer completed seed 1;
#   otherwise use the smallest completed seed.
#
# Later this can become a more sophisticated policy using verified
# performance across replicates.
# ==========================================================================

function collapse_seed_replicates(df::DataFrame)

    groups = groupby(
        df,
        [
            :environment_space,
            :number_registers,
            :purified_pairs,
            :evolution_metric,
            :code_distance,
            :sobol_index,
        ],
    )

    representative_indices = Int[]

    for g in groups

        completed_local = [
            i
            for i in 1:nrow(g)
            if result_exists(g[i, :])
        ]

        isempty(completed_local) && continue

        seed1 = findfirst(
            i -> g[i, :seed] == 1,
            completed_local,
        )

        chosen_local = if isnothing(seed1)

            completed_local[
                argmin(
                    g[completed_local, :seed]
                )
            ]

        else

            completed_local[seed1]

        end

        # Convert SubDataFrame index back to parent DataFrame index.
        push!(
            representative_indices,
            parentindices(g)[1][chosen_local],
        )
    end

    return df[
        representative_indices,
        :,
    ]
end


# ==========================================================================
# Query
# ==========================================================================

"""
    query_nearest(;
        number_registers,
        purified_pairs,
        evolution_metric,
        code_distance=1,

        network_fidelity,
        total_2q_error,
        measurement_flip,
        idle_lambda1,
        idle_lambda2,

        bias_x=1/3,
        bias_y=1/3,
        bias_z=1/3,

        k=1,
    )

Return the nearest COMPLETED database environment(s) in the exact requested
discrete resource stratum.

For k=1:
    returns one NamedTuple.

For k>1:
    returns a nearest-first Vector of NamedTuples.

NOTE:
`database_performance` is performance at the matched database environment,
not yet a fresh simulation at the exact query environment.
"""
function query_nearest(
    ;
    number_registers::Int,
    purified_pairs::Int,

    evolution_metric::Symbol = :logical_qubit_fidelity,
    code_distance::Int = 1,

    network_fidelity::Real,
    total_2q_error::Real,
    measurement_flip::Real,
    idle_lambda1::Real,
    idle_lambda2::Real,

    bias_x::Real = 1 / 3,
    bias_y::Real = 1 / 3,
    bias_z::Real = 1 / 3,

    k::Int = 1,
)

    k >= 1 || throw(
        ArgumentError("k must be >= 1")
    )
bias_x, bias_y, bias_z =
    normalize_biases(
        bias_x,
        bias_y,
        bias_z,
    )
    validate_query(
        ;
        number_registers,
        purified_pairs,
        network_fidelity,
        total_2q_error,
        measurement_flip,
        idle_lambda1,
        idle_lambda2,
        bias_x,
        bias_y,
        bias_z,
    )


    # ----------------------------------------------------------------------
    # Load cached manifest
    # ----------------------------------------------------------------------

    df = load_manifest()


    # ----------------------------------------------------------------------
    # Exact discrete-stratum filter
    # ----------------------------------------------------------------------

    mask =
        (df.number_registers .== number_registers) .&
        (df.purified_pairs .== purified_pairs) .&
        (df.evolution_metric .== String(evolution_metric)) .&
        (df.code_distance .== code_distance)

    stratum = df[
        mask,
        :,
    ]


    if nrow(stratum) == 0

        error(
            "No manifest configurations match:\n" *
            "  number_registers = $number_registers\n" *
            "  purified_pairs   = $purified_pairs\n" *
            "  evolution_metric = $evolution_metric\n" *
            "  code_distance    = $code_distance"
        )

    end


    # ----------------------------------------------------------------------
    # Keep one completed representative per physical/Sobol environment.
    #
    # This both:
    #   1. prevents unfinished manifest rows from breaking queries;
    #   2. prevents seed2/seed3 from appearing as separate nearest
    #      environmental locations.
    # ----------------------------------------------------------------------

    candidates = collapse_seed_replicates(
        stratum,
    )


    if nrow(candidates) == 0

        error(
            "The requested stratum exists in the manifest, but none of its " *
            "database points have completed successfully yet."
        )

    end


    # ----------------------------------------------------------------------
    # Build normalized 7-D query vector
    # ----------------------------------------------------------------------

    q = query_environment_vector(
        ;
        network_fidelity,
        total_2q_error,
        measurement_flip,
        idle_lambda1,
        idle_lambda2,
        bias_x,
        bias_y,
        bias_z,
    )


    # ----------------------------------------------------------------------
    # Compute NN distances
    # ----------------------------------------------------------------------

    distances = Vector{Float64}(
        undef,
        nrow(candidates),
    )

    for (i, row) in enumerate(
        eachrow(candidates)
    )

        x = row_environment_vector(row)

        distances[i] = weighted_distance(q, x)

    end


    order = sortperm(distances)

    actual_k = min(
        k,
        length(order),
    )

    top_k = order[
        1:actual_k
    ]


    # ----------------------------------------------------------------------
    # Load only selected result files
    # ----------------------------------------------------------------------

    results = map(top_k) do i

        row = candidates[i, :]
        distance = distances[i]

        path = result_path(
            row.id_string
        )

        # Should be guaranteed by collapse_seed_replicates(), but retain a
        # defensive check.
        isfile(path) || error(
            "Result disappeared while querying:\n$path"
        )

        saved = deserialize(path)


        # ------------------------------------------------------------------
        # Reliability / distance warning
        # ------------------------------------------------------------------

        warnings = String[]

        if distance > DISTANCE_WARNING_THRESHOLD

            push!(
                warnings,
                "Nearest database environment has normalized distance=" *
                "$(round(distance, digits=4)), above the current baseline " *
                "warning threshold $(DISTANCE_WARNING_THRESHOLD)."
            )

        end


        reliable = hasproperty(
            saved,
            :reliable,
        ) ? saved.reliable : missing


        if reliable === false

            push!(
                warnings,
                "Saved performance estimate was marked unreliable."
            )

        end


        warning = isempty(warnings) ?
            nothing :
            join(warnings, " ")


        # ------------------------------------------------------------------
        # Saved performance
        # ------------------------------------------------------------------

        database_performance = if hasproperty(
            saved,
            :final_performance,
        )

            saved.final_performance

        elseif hasproperty(
            saved,
            :raw_performance,
        )

            saved.raw_performance

        else

            missing

        end


        raw_performance = hasproperty(
            saved,
            :raw_performance,
        ) ? saved.raw_performance : missing


        verified_performance = hasproperty(
            saved,
            :verified_performance,
        ) ? saved.verified_performance : nothing


        # ------------------------------------------------------------------
        # Result
        # ------------------------------------------------------------------

        (
            # --------------------------------------------------------------
            # Identity
            # --------------------------------------------------------------

            match_id_string = String(
                row.id_string
            ),

            task_id = Int(
                row.task_id
            ),

            sobol_index = Int(
                row.sobol_index
            ),

            seed = Int(
                row.seed
            ),

            environment_space = row.environment_space,

            # --------------------------------------------------------------
            # Discrete stratum
            # --------------------------------------------------------------

            number_registers = Int(
                row.number_registers
            ),

            purified_pairs = Int(
                row.purified_pairs
            ),

            evolution_metric = Symbol(
                row.evolution_metric
            ),

            code_distance = Int(
                row.code_distance
            ),

            # --------------------------------------------------------------
            # Match information
            # --------------------------------------------------------------

            distance,

            warning,

            # --------------------------------------------------------------
            # Circuit
            # --------------------------------------------------------------

            circuit = saved.best_circuit,

            circuit_length = hasproperty(
                saved,
                :best_circuit_length,
            ) ? saved.best_circuit_length :
                length(saved.best_circuit.ops),

            # --------------------------------------------------------------
            # Performance
            #
            # IMPORTANT:
            # This is performance at matched_condition.
            # --------------------------------------------------------------

            database_performance,

            raw_performance,

            verified_performance,

            reliable,

            # Reserved for future kNN query-time re-evaluation.
            query_performance = nothing,

            # --------------------------------------------------------------
            # User's requested environment
            # --------------------------------------------------------------

            query_condition = (
                network_fidelity = Float64(
                    network_fidelity
                ),

                total_2q_error = Float64(
                    total_2q_error
                ),

                measurement_flip = Float64(
                    measurement_flip
                ),

                idle_lambda1 = Float64(
                    idle_lambda1
                ),

                idle_lambda2 = Float64(
                    idle_lambda2
                ),

                bias_x = Float64(
                    bias_x
                ),

                bias_y = Float64(
                    bias_y
                ),

                bias_z = Float64(
                    bias_z
                ),
            ),

            # --------------------------------------------------------------
            # Actual environment at which this database circuit was evolved
            # and evaluated.
            # --------------------------------------------------------------

            matched_condition = (
                network_fidelity = Float64(
                    row.network_fidelity
                ),

                total_2q_error = Float64(
                    row.total_2q_error
                ),

                measurement_flip = Float64(
                    row.measurement_flip
                ),

                idle_lambda1 = Float64(
                    row.idle_lambda1
                ),

                idle_lambda2 = Float64(
                    row.idle_lambda2
                ),

                bias_x = Float64(
                    row.bias_x
                ),

                bias_y = Float64(
                    row.bias_y
                ),

                bias_z = Float64(
                    row.bias_z
                ),
            ),
        )

    end


    return k == 1 ?
        results[1] :
        results
end


# ==========================================================================
# Human-readable display helper
# ==========================================================================

function print_query_result(result)

    println("="^72)
    println("NEAREST DATABASE CIRCUIT")
    println("="^72)

    println(
        "task / sobol = ",
        result.task_id,
        " / ",
        result.sobol_index,
    )

    println(
        "resource     = nr=",
        result.number_registers,
        " pp=",
        result.purified_pairs,
    )

    println(
        "metric       = ",
        result.evolution_metric,
    )

    println(
        "seed         = ",
        result.seed,
    )

    println(
        "distance     = ",
        round(
            result.distance,
            digits = 6,
        ),
    )

    if !isnothing(result.warning)

        println(
            "WARNING      = ",
            result.warning,
        )

    end


    println()
    println("Requested environment:")
    println(
        "  network = ",
        result.query_condition.network_fidelity,
    )
    println(
        "  2q      = ",
        result.query_condition.total_2q_error,
    )
    println(
        "  meas    = ",
        result.query_condition.measurement_flip,
    )
    println(
        "  T1/T2   = ",
        result.query_condition.idle_lambda1,
        " / ",
        result.query_condition.idle_lambda2,
    )
    println(
        "  bias    = (",
        result.query_condition.bias_x,
        ", ",
        result.query_condition.bias_y,
        ", ",
        result.query_condition.bias_z,
        ")",
    )


    println()
    println("Matched database environment:")
    println(
        "  network = ",
        result.matched_condition.network_fidelity,
    )
    println(
        "  2q      = ",
        result.matched_condition.total_2q_error,
    )
    println(
        "  meas    = ",
        result.matched_condition.measurement_flip,
    )
    println(
        "  T1/T2   = ",
        result.matched_condition.idle_lambda1,
        " / ",
        result.matched_condition.idle_lambda2,
    )
    println(
        "  bias    = (",
        result.matched_condition.bias_x,
        ", ",
        result.matched_condition.bias_y,
        ", ",
        result.matched_condition.bias_z,
        ")",
    )


    println()
    println(
        "Circuit length = ",
        result.circuit_length,
    )


    println()
    println("Circuit:")

    if isempty(result.circuit.ops)

        println("  <empty circuit>")

    else

        for op in result.circuit.ops
            println("  ", op)
        end

    end


    println()
    println(
        "Database performance = ",
        result.database_performance,
    )

    println(
        "Reliable             = ",
        result.reliable,
    )

    println("="^72)

    return nothing
end


# ==========================================================================
# Example
# ==========================================================================

# result = query_nearest(
#     ;
#     number_registers = 3,
#     purified_pairs = 1,
#     evolution_metric = :logical_qubit_fidelity,
#     code_distance = 1,
#
#     network_fidelity = 0.88,
#     total_2q_error = 0.015,
#     measurement_flip = 0.015,
#     idle_lambda1 = 0.005,
#     idle_lambda2 = 0.025,
#
#     bias_x = 1/3,
#     bias_y = 1/3,
#     bias_z = 1/3,
# )
#
# print_query_result(result)
