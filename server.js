const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const ROOT = path.resolve(__dirname);
const WEB_DIR = path.join(ROOT, "web");
const INDEX_FILE = path.join(
    ROOT,
    "web_export",
    "web_index.json"
);

const ANALYTICS_DIR = path.join(
    ROOT,
    "results",
    "database",
    "analytics"
);

const PORT = Number(process.env.PORT || 8080);


// ============================================================
// Middleware
// ============================================================

app.use(express.json());


// ============================================================
// NN configuration
//
// Must match query_nearest_circuit.jl
// ============================================================

const CONTINUOUS_FIELDS = [
    "network_fidelity",
    "total_2q_error",
    "measurement_flip",
    "idle_lambda1",
    "idle_lambda2",
];

const PHYSICAL_LB = [
    0.60,
    0.00,
    0.00,
    0.00,
    0.00,
];

const PHYSICAL_UB = [
    0.99,
    0.20,
    0.30,
    0.10,
    0.10,
];

const DISTANCE_WEIGHTS = [
    2.0, // network fidelity
    3.0, // 2Q error
    2.0, // measurement
    1.0, // T1
    1.0, // T2
    1.0, // bias coordinate 1
    1.0, // bias coordinate 2
];

const DISTANCE_WARNING_THRESHOLD = 0.25;


// ============================================================
// Load lightweight database
// ============================================================

let points = [];
let strata = new Map();


function stratumKey(point) {
    return [
        Number(point.number_registers),
        Number(point.purified_pairs),
        String(point.evolution_metric),
        Number(point.code_distance),
    ].join("|");
}


function rebuildStrata() {
    strata = new Map();

    for (const point of points) {
        const key = stratumKey(point);

        if (!strata.has(key)) {
            strata.set(key, []);
        }

        strata.get(key).push(point);
    }
}


function loadIndex() {
    if (!fs.existsSync(INDEX_FILE)) {
        throw new Error(
            `Web index does not exist: ${INDEX_FILE}`
        );
    }

    const raw = fs.readFileSync(
        INDEX_FILE,
        "utf8"
    );

    points = JSON.parse(raw);

    rebuildStrata();

    console.log(
        `Loaded ${points.length} web points across ${strata.size} strata`
    );
}


// ============================================================
// Bias helpers
// ============================================================

function normalizeBiases(bx, by, bz) {
    const biases = [
        Number(bx),
        Number(by),
        Number(bz),
    ];

    if (!biases.every(Number.isFinite)) {
        throw new Error(
            "Pauli bias values must be finite"
        );
    }

    if (!biases.every(x => x >= 0)) {
        throw new Error(
            "Pauli bias values must be non-negative"
        );
    }

    const total =
        biases[0] +
        biases[1] +
        biases[2];

    if (total <= 0) {
        throw new Error(
            "At least one Pauli bias value must be greater than zero"
        );
    }

    return [
        biases[0] / total,
        biases[1] / total,
        biases[2] / total,
    ];
}


// ============================================================
// Environment vector helpers
// ============================================================

function normalizePhysical(field, value) {
    const index =
        CONTINUOUS_FIELDS.indexOf(field);

    if (index < 0) {
        throw new Error(
            `Unknown continuous field: ${field}`
        );
    }

    const lb = PHYSICAL_LB[index];
    const ub = PHYSICAL_UB[index];

    return (
        (Number(value) - lb) /
        (ub - lb)
    );
}


function biasTo2D(bx, by, bz) {
    const u =
        Number(by) +
        0.5 * Number(bz);

    const v =
        (Math.sqrt(3) / 2) *
        Number(bz);

    return [u, v];
}


function environmentVector({
    network_fidelity,
    total_2q_error,
    measurement_flip,
    idle_lambda1,
    idle_lambda2,
    bias_x,
    bias_y,
    bias_z,
}) {
    const [bu, bv] =
        biasTo2D(
            bias_x,
            bias_y,
            bias_z
        );

    return [
        normalizePhysical(
            "network_fidelity",
            network_fidelity
        ),

        normalizePhysical(
            "total_2q_error",
            total_2q_error
        ),

        normalizePhysical(
            "measurement_flip",
            measurement_flip
        ),

        normalizePhysical(
            "idle_lambda1",
            idle_lambda1
        ),

        normalizePhysical(
            "idle_lambda2",
            idle_lambda2
        ),

        bu,
        bv,
    ];
}


function pointEnvironmentVector(point) {
    return environmentVector({
        network_fidelity:
            point.network_fidelity,

        total_2q_error:
            point.total_2q_error,

        measurement_flip:
            point.measurement_flip,

        idle_lambda1:
            point.idle_lambda1,

        idle_lambda2:
            point.idle_lambda2,

        bias_x:
            point.bias_x,

        bias_y:
            point.bias_y,

        bias_z:
            point.bias_z,
    });
}


function weightedDistance(a, b) {
    let sum = 0;

    for (let i = 0; i < a.length; i++) {
        const delta =
            Number(a[i]) -
            Number(b[i]);

        sum +=
            DISTANCE_WEIGHTS[i] *
            delta *
            delta;
    }

    return Math.sqrt(sum);
}


// ============================================================
// Validation
// ============================================================

function validatePhysical(values) {
    for (
        let i = 0;
        i < CONTINUOUS_FIELDS.length;
        i++
    ) {
        const field =
            CONTINUOUS_FIELDS[i];

        const value =
            Number(values[field]);

        const lb =
            PHYSICAL_LB[i];

        const ub =
            PHYSICAL_UB[i];

        if (
            !Number.isFinite(value) ||
            value < lb ||
            value > ub
        ) {
            throw new Error(
                `${field}=${value} is outside env_v1 bounds [${lb}, ${ub}]`
            );
        }
    }
}


// ============================================================
// Query
// ============================================================

function queryNearest(body) {
    const nr =
        Number(body.number_registers);

    const pp =
        Number(body.purified_pairs);

    const metric =
        String(body.evolution_metric);

    const codeDistance =
        Number(body.code_distance);


    if (
        !Number.isInteger(nr) ||
        nr < 2
    ) {
        throw new Error(
            "number_registers must be >= 2"
        );
    }


    if (
        !Number.isInteger(pp) ||
        pp < 1
    ) {
        throw new Error(
            "purified_pairs must be >= 1"
        );
    }


    if (pp > nr) {
        throw new Error(
            `purified_pairs=${pp} cannot exceed number_registers=${nr}`
        );
    }


    const environment = {
        network_fidelity:
            Number(body.network_fidelity),

        total_2q_error:
            Number(body.total_2q_error),

        measurement_flip:
            Number(body.measurement_flip),

        idle_lambda1:
            Number(body.idle_lambda1),

        idle_lambda2:
            Number(body.idle_lambda2),
    };


    validatePhysical(environment);


    const [
        biasX,
        biasY,
        biasZ,
    ] = normalizeBiases(
        body.bias_x,
        body.bias_y,
        body.bias_z
    );


    const key = [
        nr,
        pp,
        metric,
        codeDistance,
    ].join("|");


    const candidates =
        strata.get(key);


    if (
        !candidates ||
        candidates.length === 0
    ) {
        throw new Error(
            "No exported database points match:\n" +
            `number_registers = ${nr}\n` +
            `purified_pairs = ${pp}\n` +
            `evolution_metric = ${metric}\n` +
            `code_distance = ${codeDistance}`
        );
    }


    const queryVector =
        environmentVector({
            ...environment,

            bias_x: biasX,
            bias_y: biasY,
            bias_z: biasZ,
        });


    let best = null;
    let bestDistance = Infinity;


    for (const point of candidates) {
        const pointVector =
            pointEnvironmentVector(point);

        const distance =
            weightedDistance(
                queryVector,
                pointVector
            );

        if (distance < bestDistance) {
            bestDistance = distance;
            best = point;
        }
    }


    let warning = null;

    if (
        bestDistance >
        DISTANCE_WARNING_THRESHOLD
    ) {
        warning =
            "Nearest database environment has normalized distance=" +
            bestDistance.toFixed(4) +
            ", above the current baseline warning threshold " +
            DISTANCE_WARNING_THRESHOLD +
            ".";
    }


    const requested = {
        ...environment,

        bias_x: biasX,
        bias_y: biasY,
        bias_z: biasZ,
    };


    const matched = {
        network_fidelity:
            Number(best.network_fidelity),

        total_2q_error:
            Number(best.total_2q_error),

        measurement_flip:
            Number(best.measurement_flip),

        idle_lambda1:
            Number(best.idle_lambda1),

        idle_lambda2:
            Number(best.idle_lambda2),

        bias_x:
            Number(best.bias_x),

        bias_y:
            Number(best.bias_y),

        bias_z:
            Number(best.bias_z),
    };


    const performance = {
        logical_qubit_fidelity:
            best.logical_qubit_fidelity,

        purified_pairs_fidelity:
            best.purified_pairs_fidelity,

        average_marginal_fidelity:
            best.average_marginal_fidelity,

        success_probability:
            best.success_probability,
    };


    const assets = {

        history_image:
            best.history_data,

        fin_fout_image:
            best.fin_fout_data,
    };


    return {
        task_id:
            Number(best.task_id),

        sobol_index:
            Number(best.sobol_index),

        id_string:
            String(best.id_string),

        seed:
            Number(best.seed),

        number_registers:
            Number(best.number_registers),

        purified_pairs:
            Number(best.purified_pairs),

        evolution_metric:
            String(best.evolution_metric),

        code_distance:
            Number(best.code_distance),

        distance:
            bestDistance,

        warning,

        circuit_length:
            Number(best.circuit_length),

        circuit_ops:
            Array.isArray(best.circuit_ops)
                ? best.circuit_ops
                : [],

        performance,

        reliable:
            best.reliable,

        requested,

        matched,

        assets,
    };
}


// ============================================================
// Routes
// ============================================================

app.get(
    "/health",
    (req, res) => {
        res
            .status(200)
            .type("text/plain")
            .send("ok");
    }
);


app.post(
    "/api/query",
    (req, res) => {
        try {
            const result =
                queryNearest(req.body);

            res.json(result);

        } catch (error) {
            console.error(error);

            res.status(400).json({
                error:
                    error.message,
            });
        }
    }
);


app.post(
    "/api/reload",
    (req, res) => {
        try {
            loadIndex();

            res.json({
                points:
                    points.length,

                strata:
                    strata.size,
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    error.message,
            });
        }
    }
);


// ============================================================
// Static analytics
// ============================================================

app.use(
    "/assets",
    express.static(
        ANALYTICS_DIR,
        {
            maxAge:
                "1h",
        }
    )
);


// ============================================================
// Frontend
// ============================================================

app.use(
    express.static(
        WEB_DIR,
        {
            index:
                "index.html",
        }
    )
);


app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                WEB_DIR,
                "index.html"
            )
        );
    }
);


// ============================================================
// Start
// ============================================================

loadIndex();


app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `QEP web server listening on 0.0.0.0:${PORT}`
        );

        console.log(
            `Web points: ${points.length}`
        );

        console.log(
            `Strata: ${strata.size}`
        );

        console.log(
            `Index: ${INDEX_FILE}`
        );

        console.log(
            `Analytics: ${ANALYTICS_DIR}`
        );
    }
);
