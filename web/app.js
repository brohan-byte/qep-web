function number(id) {

    return Number($(id).value);
}

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


function renderImage(containerId, title, url) {
    const container = $(containerId);

    if (!url) {
        container.innerHTML = `
            <p class="muted">
                ${title} has not been precomputed for this point yet.
            </p>
        `;
        return;
    }

    container.innerHTML = `
        <img
            src="${url}"
            alt="${title}"
            loading="lazy"
        >
    `;
}


async function queryCircuit() {

    $("status").textContent = "Searching database...";
    $("results").classList.add("hidden");


    // ------------------------------------------------------------------
    // Pauli bias normalization
    //
    // Users may enter approximate fractions:
    //
    //     X = 0.30
    //     Y = 0.30
    //     Z = 0.38
    //
    // or relative weights:
    //
    //     X = 1
    //     Y = 2
    //     Z = 1
    //
    // They are normalized before being sent to the backend.
    // ------------------------------------------------------------------

    const bx = number("bias_x");
    const by = number("bias_y");
    const bz = number("bias_z");


    if (![bx, by, bz].every(Number.isFinite)) {

        $("status").textContent =
            "Error: Pauli bias values must be valid numbers.";

        return;
    }


    if (bx < 0 || by < 0 || bz < 0) {

        $("status").textContent =
            "Error: Pauli bias values must be non-negative.";

        return;
    }


    const biasSum = bx + by + bz;


    if (biasSum <= 0) {

        $("status").textContent =
            "Error: At least one Pauli bias must be greater than zero.";

        return;
    }


    const normBx = bx / biasSum;
    const normBy = by / biasSum;
    const normBz = bz / biasSum;


    // ------------------------------------------------------------------
    // Query payload
    // ------------------------------------------------------------------

    const payload = {
number_registers: number("number_registers"),
        purified_pairs:
            number("purified_pairs"),

        evolution_metric:
            $("evolution_metric").value,

        code_distance:
            number("code_distance"),

        network_fidelity:
            number("network_fidelity"),

        total_2q_error:
            number("total_2q_error"),

        measurement_flip:
            number("measurement_flip"),

        idle_lambda1:
            number("idle_lambda1"),

        idle_lambda2:
            number("idle_lambda2"),

        bias_x: normBx,
        bias_y: normBy,
        bias_z: normBz,
    };


    try {

        const response = await fetch(
            "/api/query",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                },

                body: JSON.stringify(payload),
            }
        );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.error || "Query failed"
            );
        }


        $("status").textContent = "";


        // --------------------------------------------------------------
        // Nearest database match
        // --------------------------------------------------------------

        $("match-summary").innerHTML = `
            <p>
                <strong>Database ID:</strong>
                ${result.id_string}
            </p>

            <p>
                <strong>Task:</strong>
                ${result.task_id}
            </p>

            <p>
                <strong>Sobol index:</strong>
                ${result.sobol_index}
            </p>

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


        // --------------------------------------------------------------
        // Requested vs matched environment
        // --------------------------------------------------------------

        $("environment-comparison").innerHTML =
            environmentTable(
             result.requested,
                result.matched
            );


        // --------------------------------------------------------------
        // Circuit
        // --------------------------------------------------------------

        $("circuit-summary").innerHTML = `
            <p>
                <strong>Circuit length:</strong>
                ${result.circuit_length}
            </p>
        `;


        // Circuit operation list
        if ($("circuit-ops")) {

            if (
                result.circuit_ops &&
                result.circuit_ops.length > 0
            ) {

                $("circuit-ops").textContent =
                    result.circuit_ops
                        .map(
                            (op, index) =>
                                `${index + 1}. ${op}`
                        )
                        .join("\n");

            } else {

                $("circuit-ops").textContent =
                    "<empty circuit>";
            }
        }


        // --------------------------------------------------------------
        // Saved performance
        // --------------------------------------------------------------

        const p = result.performance;


        if (p) {

            $("performance").innerHTML = `
                <table>
                    <tbody>

                        <tr>
                            <td>Logical qubit fidelity</td>
                            <td>
                                ${Number(
                                    p.logical_qubit_fidelity
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>Purified-pair fidelity</td>
                            <td>
                                ${Number(
                                    p.purified_pairs_fidelity
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>Average marginal fidelity</td>
                            <td>
                                ${Number(
                                    p.average_marginal_fidelity
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>Success probability</td>
                            <td>
                                ${Number(
                                    p.success_probability
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>Reliable</td>
                            <td>
                                ${result.reliable}
                            </td>
                        </tr>

                    </tbody>
                </table>
            `;

        } else {

            $("performance").innerHTML =
                "<p>No saved performance metadata.</p>";
        }


        // --------------------------------------------------------------
        // PRECOMPUTED images only.
        //
        // No Quantikz generation, simulation, or F-in/F-out analysis
        // happens here.
        // --------------------------------------------------------------

        await renderHistory(

    result.assets.history_data

);

await renderFinFout(

    result.assets.fin_fout_data

);

        $("results").classList.remove("hidden");


    } catch (error) {

        $("status").textContent =
            `Error: ${error.message}`;
    }
}


$("query-button").addEventListener(
    "click",
    queryCircuit
);
