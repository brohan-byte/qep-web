function renderCircuit(result) {
    document.getElementById("circuit-summary").textContent =
        `Circuit length: ${result.circuit_length}`;

    document.getElementById("circuit-ops").textContent =
        Array.isArray(result.circuit_ops) && result.circuit_ops.length
            ? result.circuit_ops.map((op, i) => `${i + 1}. ${op}`).join("\n")
            : "<empty circuit>";
}
async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    if (url.endsWith(".gz")) {
        const stream = response.body.pipeThrough(
            new DecompressionStream("gzip")
        );

        const text = await new Response(stream).text();

        return JSON.parse(text);
    }

    return response.json();
}
async function renderHistoryPanel(data) {
    const container = document.getElementById("history-figure");

     if (!data) {
        container.innerHTML =
            "<p class='muted'>Optimization history is not available for this circuit.</p>";
        return;
    }
    try {

        const fitness = data.fitness_history;

        if (!Array.isArray(fitness) || !fitness.length || !Array.isArray(fitness[0])) {
            throw new Error("fitness_history is not a 2-D matrix");
        }

        const generations = fitness.map((_, i) => i + 1);
        const best = fitness.map(row => Math.max(...row));
        const worst = fitness.map(row => Math.min(...row));

        /*
         * Julia:
         * fitness_history[generation][individual]
         *
         * CairoMakie plots:
         * fitness_history[:, end:-1:begin]
         *
         * Plotly heatmap expects z[y][x], so transpose while
         * reversing the individual dimension.
         */
        const individuals = fitness[0].length;

        const heatmap = Array.from(
            { length: individuals },
            (_, y) => fitness.map(row => row[individuals - 1 - y])
        );

        container.innerHTML = `
            <div id="fitness-heatmap"></div>
            <div id="best-worst"></div>
            <div id="transition-counts"></div>
        `;

        await Plotly.newPlot("fitness-heatmap", [{
            z: heatmap,
            type: "heatmap",
            zmin: 0.9,
            zmax: 1.0,
            colorbar: { title: "Fitness" },
        }], {
            title: "Fitness history",
            xaxis: { title: "Generation" },
            yaxis: { title: "Individual" },
        }, {
            responsive: true,
        });

        await Plotly.newPlot("best-worst", [
            {
                x: generations,
                y: best,
                mode: "lines",
                name: "Best",
            },
            {
                x: generations,
                y: worst,
                mode: "lines",
                name: "Worst",
            },
        ], {
            title: "Best / worst fitness",
            xaxis: { title: "Generation" },
            yaxis: { title: "Fitness" },
        }, {
            responsive: true,
        });

        if (
            Array.isArray(data.transition_counts_matrix) &&
            Array.isArray(data.transition_counts_keys)
        ) {
            const matrix = data.transition_counts_matrix;
            const transitionGenerations = matrix.map((_, i) => i + 1);

            const traces = data.transition_counts_keys.map((key, column) => ({
                x: transitionGenerations,
                y: matrix.map(row => row[column]),
                mode: "lines",
                name: String(key),
            }));

            await Plotly.newPlot("transition-counts", traces, {
                title: "Circuit type over generations",
                xaxis: { title: "Generation" },
                yaxis: { title: "Type" },
            }, {
                responsive: true,
            });
        }

    } catch (error) {
        console.error("History rendering failed:", error);

        container.innerHTML =
            `<p class="muted">Could not load optimization history (${error.message}).</p>`;
    }
}
async function renderFinFoutPanel(data) {
    const container = document.getElementById("fin-fout-figure");

    if (!data) {
        container.innerHTML =
            "<p class='muted'>F-in/F-out analysis is not available for this circuit.</p>";
        return;
    }
    try {
        if (!Array.isArray(data.f_ins) || !data.f_ins.length) {
            throw new Error("f_ins is empty or missing");
        }

        container.innerHTML = `
            <div id="fin-fout-fidelity"></div>
            <div id="fin-fout-success"></div>
        `;

        await Plotly.newPlot("fin-fout-fidelity", [
            {
                x: [0, 1],
                y: [0, 1],
                mode: "lines",
                line: { dash: "dash", color: "gray" },
                showlegend: false,
                hoverinfo: "skip",
            },
            {
                x: data.f_ins,
                y: data.f_out_noise,
                mode: "lines",
                name: "With local circuit noise",
            },
            {
                x: data.f_ins,
                y: data.f_out_clean,
                mode: "lines",
                name: "Without local circuit noise",
            },
        ], {
            title: "F in vs F out",
            xaxis: { title: "F in", range: [0, 1] },
            yaxis: { title: "F out", range: [0, 1] },
        }, {
            responsive: true,
        });

        await Plotly.newPlot("fin-fout-success", [
            {
                x: data.f_ins,
                y: data.success_noise,
                mode: "lines",
                name: "With local circuit noise",
            },
            {
                x: data.f_ins,
                y: data.success_clean,
                mode: "lines",
                name: "Without local circuit noise",
            },
        ], {
            title: "F in vs success probability",
            xaxis: { title: "F in", range: [0, 1] },
            yaxis: { title: "Success probability" },
        }, {
            responsive: true,
        });

        if (data.num_simulations != null) {
            container.insertAdjacentHTML(
                "beforeend",
                `<p class="muted">Simulations per point: ${data.num_simulations}</p>`
            );
        }

    } catch (error) {
        console.error("F-in/F-out rendering failed:", error);

        container.innerHTML =
            `<p class="muted">Could not load F-in/F-out analysis (${error.message}).</p>`;
    }
}

async function renderAnalytics(result) {
    renderCircuit(result);

    await Promise.all([
        renderHistoryPanel(result.assets?.history_data),
        renderFinFoutPanel(result.assets?.fin_fout_data),
    ]);
}
