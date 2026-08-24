const $ = id => document.getElementById(id);
const num = id => Number($(id).value);

function environmentTable(requested, matched) {
    const rows = [
        ["Network fidelity", "network_fidelity"],
        ["2Q error", "total_2q_error"],
        ["Measurement flip", "measurement_flip"],
        ["Idle λ1", "idle_lambda1"],
        ["Idle λ2", "idle_lambda2"],
        ["Bias X", "bias_x"],
        ["Bias Y", "bias_y"],
        ["Bias Z", "bias_z"],
    ];

    return `
        <table>
            <thead>
                <tr>
                    <th>Parameter</th>
                    <th>Requested</th>
                    <th>Matched</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(([label, key]) => `
                    <tr>
                        <td>${label}</td>
                        <td>${Number(requested[key]).toFixed(5)}</td>
                        <td>${Number(matched[key]).toFixed(5)}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

async function queryCircuit() {
    $("status").textContent = "Searching database...";
    $("results").classList.add("hidden");

    const bx = num("bias_x");
    const by = num("bias_y");
    const bz = num("bias_z");
    const sum = bx + by + bz;

    if (
        ![bx, by, bz].every(Number.isFinite) ||
        bx < 0 ||
        by < 0 ||
        bz < 0 ||
        sum <= 0
    ) {
        $("status").textContent =
            "Error: Pauli biases must be non-negative numbers with a positive sum.";
        return;
    }

    const payload = {
        number_registers: num("number_registers"),
        purified_pairs: num("purified_pairs"),
        evolution_metric: $("evolution_metric").value,
        code_distance: num("code_distance"),

        network_fidelity: num("network_fidelity"),
        total_2q_error: num("total_2q_error"),
        measurement_flip: num("measurement_flip"),
        idle_lambda1: num("idle_lambda1"),
        idle_lambda2: num("idle_lambda2"),

        bias_x: bx / sum,
        bias_y: by / sum,
        bias_z: bz / sum,
    };

    try {
        const response = await fetch("/api/query", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Query failed");
        }

        $("status").textContent = "";

        $("match-summary").innerHTML = `
            <p><strong>Database ID:</strong> ${result.id_string}</p>
            <p><strong>Task:</strong> ${result.task_id}</p>
            <p><strong>Sobol index:</strong> ${result.sobol_index}</p>
            <p>
                <strong>Normalized NN distance:</strong>
                ${Number(result.distance).toFixed(6)}
            </p>
            ${
                result.warning
                    ? `<p class="warning">${result.warning}</p>`
                    : ""
            }
        `;

        $("environment-comparison").innerHTML =
            environmentTable(
                result.requested,
                result.matched
            );

        const p = result.performance;

        $("performance").innerHTML = p
            ? `
                <table>
                    <tbody>
                        <tr>
                            <td>Logical qubit fidelity</td>
                            <td>${Number(
                                p.logical_qubit_fidelity
                            ).toFixed(6)}</td>
                        </tr>

                        <tr>
                            <td>Purified-pair fidelity</td>
                            <td>${Number(
                                p.purified_pairs_fidelity
                            ).toFixed(6)}</td>
                        </tr>

                        <tr>
                            <td>Average marginal fidelity</td>
                            <td>${Number(
                                p.average_marginal_fidelity
                            ).toFixed(6)}</td>
                        </tr>

                        <tr>
                            <td>Success probability</td>
                            <td>${Number(
                                p.success_probability
                            ).toFixed(6)}</td>
                        </tr>

                        <tr>
                            <td>Reliable</td>
                            <td>${result.reliable}</td>
                        </tr>
                    </tbody>
                </table>
            `
            : "<p>No saved performance metadata.</p>";

        $("results").classList.remove("hidden");

        await renderAnalytics(result);

    } catch (error) {
        $("status").textContent =
            `Error: ${error.message}`;
    }
}

$("query-button").addEventListener(
    "click",
    queryCircuit
);
