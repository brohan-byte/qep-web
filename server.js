const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const zlib = require("zlib");
const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, "web");
const PORT = Number(process.env.PORT || 8080);
const FIELDS = [
    "network_fidelity",
    "total_2q_error",
    "measurement_flip",
    "idle_lambda1",
    "idle_lambda2",
];
const HF_BASE =
"https://huggingface.co/datasets/rohankpdi/qep-analytics/resolve/main";

const INDEX_BASE_URL =
`${HF_BASE}/web_index_strata`;

const METADATA_BASE_URL =
`${HF_BASE}/point_metadata`;

const HISTORY_BASE_URL =
`${HF_BASE}/history_data`;

const FIN_FOUT_BASE_URL =
`${HF_BASE}/fin_fout`;
const LB = [0.60, 0.00, 0.00, 0.00, 0.00];
const UB = [0.99, 0.20, 0.30, 0.10, 0.10];
const WEIGHTS = [2, 3, 2, 1, 1, 1, 1];
const WARNING_DISTANCE = 0.25;


app.use(express.json());
function historyShard(id) {
    const crypto = require("crypto");

    return crypto
        .createHash("md5")
        .update(id)
        .digest("hex")
        .slice(0, 4);
}


async function loadMetadata(id) {

    const shard =
        shardOf(id);

    const url =
        `${METADATA_BASE_URL}/shard_${shard}.jsonl.gz`;

    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Metadata shard failed: ${response.status}`
        );
    }

    const buffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    const text =
        zlib
            .gunzipSync(buffer)
            .toString("utf8");

    for (const line of text.split("\n")) {

        if (!line.trim()) continue;

        const record =
            JSON.parse(line);

        if (record.id_string === id) {
            return record;
        }
    }

    throw new Error(
        `Metadata missing for ${id}`
    );
}


function shardOf(id) {
    const crypto = require("crypto");

    return (
        parseInt(
            crypto
                .createHash("md5")
                .update(id)
                .digest("hex")
                .slice(0, 8),
            16
        ) % 4096
    )
        .toString()
        .padStart(4, "0");
}
function keyOf(point) {
    return [
        Number(point.number_registers),
        Number(point.purified_pairs),
        String(point.evolution_metric),
        Number(point.code_distance),
    ].join("|");
}
async function loadStratum(
    nr,
    pp,
    metric,
    d
) {
    const filename =
        `nr${nr}_pp${pp}_${metric}_d${d}.json`;

    const url =
        `${INDEX_BASE_URL}/${filename}`;

    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Failed to load stratum ${filename}: ${response.status}`
        );
    }

    return await response.json();
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

async function queryNearest(body) {
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
    await loadStratum(
        nr,
        pp,
        metric,
        codeDistance
    );
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
    const metadata = await loadMetadata(best.id_string);

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
    Number(metadata.circuit_length),

circuit_ops:
    Array.isArray(metadata.circuit_ops)
        ? metadata.circuit_ops
        : [],
        performance:metadata.performance,
        reliable:
            best.reliable,

        requested,
        matched,
        assets: {

    history_data:
        `${HISTORY_BASE_URL}/shard_${shardOf(best.id_string)}.jsonl.gz`,

    fin_fout_data:
        `${FIN_FOUT_BASE_URL}/shard_${shardOf(best.id_string)}.jsonl.gz`
}
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
    async (req, res) => {
        try {
            res.json(
                   await queryNearest(req.body)
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
        res.json({
    message: "Index reload disabled: using sharded indexes"
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
async function startServer() {
    try {
    app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `QEP web server listening on 0.0.0.0:${PORT}`
        );
    }
);
    } catch (error) {
        console.error(
            "Failed to start server:",
            error
        );
        process.exit(1);
    }
}

startServer();
