const express = require("express");
const fs = require("fs");
const path = require("path");
const ANALYTICS_BASE_URL =
    "https://huggingface.co/datasets/rohankpdi/qep-analytics/resolve/main";
const app = express();

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, "web");
const INDEX_FILE = path.join(ROOT, "web_export", "web_index.json");
const ANALYTICS_DIR = path.join(ROOT, "results", "database", "analytics");

const PORT = Number(process.env.PORT || 8080);

const FIELDS = [
    "network_fidelity",
    "total_2q_error",
    "measurement_flip",
    "idle_lambda1",
    "idle_lambda2",
];

const LB = [0.60, 0.00, 0.00, 0.00, 0.00];
const UB = [0.99, 0.20, 0.30, 0.10, 0.10];
const WEIGHTS = [2, 3, 2, 1, 1, 1, 1];

const WARNING_DISTANCE = 0.25;

let points = [];
let strata = new Map();

app.use(express.json());

function keyOf(point) {
    return [
        Number(point.number_registers),
        Number(point.purified_pairs),
        String(point.evolution_metric),
        Number(point.code_distance),
    ].join("|");
}

function loadIndex() {
    if (!fs.existsSync(INDEX_FILE)) {
        console.warn(
            "web_index.json not found, starting with empty index"
        );
        points = [];
        strata = new Map();
        return;
    }

    points = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    strata = new Map();

    for (const point of points) {
        const key = keyOf(point);

        if (!strata.has(key)) {
            strata.set(key, []);
        }

        strata.get(key).push(point);
    }

    console.log(
        `Loaded ${points.length} points across ${strata.size} strata`
    );
}
function normalizeBiases(x, y, z) {
    const biases = [Number(x), Number(y), Number(z)];

    if (
        !biases.every(Number.isFinite) ||
        !biases.every(value => value >= 0)
    ) {
        throw new Error(
            "Pauli bias values must be finite and non-negative"
        );
    }

    const sum = biases[0] + biases[1] + biases[2];

    if (sum <= 0) {
        throw new Error(
            "At least one Pauli bias must be greater than zero"
        );
    }

    return biases.map(value => value / sum);
}

function vector(environment) {
    const physical = FIELDS.map((field, index) => {
        const value = Number(environment[field]);

        if (
            !Number.isFinite(value) ||
            value < LB[index] ||
            value > UB[index]
        ) {
            throw new Error(
                `${field}=${value} is outside env_v1 bounds ` +
                `[${LB[index]}, ${UB[index]}]`
            );
        }

        return (
            (value - LB[index]) /
            (UB[index] - LB[index])
        );
    });

    const by = Number(environment.bias_y);
    const bz = Number(environment.bias_z);

    return [
        ...physical,
        by + 0.5 * bz,
        (Math.sqrt(3) / 2) * bz,
    ];
}

function weightedDistance(a, b) {
    return Math.sqrt(
        a.reduce(
            (sum, value, index) =>
                sum +
                WEIGHTS[index] *
                (value - b[index]) ** 2,
            0
        )
    );
}

function queryNearest(body) {
    const nr = Number(body.number_registers);
    const pp = Number(body.purified_pairs);
    const metric = String(body.evolution_metric);
    const codeDistance = Number(body.code_distance);

    if (!Number.isInteger(nr) || nr < 2) {
        throw new Error(
            "number_registers must be >= 2"
        );
    }

    if (!Number.isInteger(pp) || pp < 1) {
        throw new Error(
            "purified_pairs must be >= 1"
        );
    }

    if (pp > nr) {
        throw new Error(
            `purified_pairs=${pp} cannot exceed number_registers=${nr}`
        );
    }

    const [bias_x, bias_y, bias_z] =
        normalizeBiases(
            body.bias_x,
            body.bias_y,
            body.bias_z
        );

    const requested = {
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

        bias_x,
        bias_y,
        bias_z,
    };

    const key = [
        nr,
        pp,
        metric,
        codeDistance,
    ].join("|");

    const candidates =
        strata.get(key);

    if (!candidates?.length) {
        throw new Error(
            `No exported database points match: ` +
            `number_registers=${nr}, ` +
            `purified_pairs=${pp}, ` +
            `evolution_metric=${metric}, ` +
            `code_distance=${codeDistance}`
        );
    }

    const queryVector =
        vector(requested);

    let best = null;
    let bestDistance = Infinity;

    for (const point of candidates) {
        const distance =
            weightedDistance(
                queryVector,
                vector(point)
            );

        if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
        }
    }

    const matched =
        Object.fromEntries(
            [
                ...FIELDS,
                "bias_x",
                "bias_y",
                "bias_z",
            ].map(
                field => [
                    field,
                    Number(best[field]),
                ]
            )
        );

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

        warning:
            bestDistance > WARNING_DISTANCE
                ? (
                    `Nearest database environment has normalized ` +
                    `distance=${bestDistance.toFixed(4)}, above the ` +
                    `warning threshold ${WARNING_DISTANCE}.`
                )
                : null,

        circuit_length:
            Number(best.circuit_length),

        circuit_ops:
            Array.isArray(best.circuit_ops)
                ? best.circuit_ops
                : [],

        performance: {
            logical_qubit_fidelity:
                best.logical_qubit_fidelity,

            purified_pairs_fidelity:
                best.purified_pairs_fidelity,

            average_marginal_fidelity:
                best.average_marginal_fidelity,

            success_probability:
                best.success_probability,
        },

        reliable:
            best.reliable,

        requested,
        matched,
        assets: {
    history_data:
        best.history_data
            ? `${ANALYTICS_BASE_URL}/history_data/${best.id_string}.json.gz`
            : null,

    fin_fout_data:
        best.fin_fout_data
            ? `${ANALYTICS_BASE_URL}/fin_fout/${best.id_string}.json`
            : null,
},
    };
}

app.get(
    "/health",
    (req, res) => {
        res
            .type("text/plain")
            .send("ok");
    }
);

app.post(
    "/api/query",
    (req, res) => {
        try {
            res.json(
                queryNearest(req.body)
            );
        } catch (error) {
            console.error(error);

            res
                .status(400)
                .json({
                    error: error.message,
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
                points: points.length,
                strata: strata.size,
            });
        } catch (error) {
            res
                .status(500)
                .json({
                    error: error.message,
                });
        }
    }
);

/*
 * Serve analytics JSON.
 *
 * Disable caching while the database is
 * still actively being regenerated.
 */
app.use(
    "/assets",
    express.static(
        ANALYTICS_DIR,
        {
            maxAge: 0,
            etag: false,

            setHeaders: res => {
                res.setHeader(
                    "Cache-Control",
                    "no-store"
                );
            },
        }
    )
);

/*
 * Serve frontend.
 */
app.use(
    express.static(
        WEB_DIR,
        {
            index: "index.html",
        }
    )
);

loadIndex();

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `QEP web server listening on 0.0.0.0:${PORT}`
        );
    }
);
