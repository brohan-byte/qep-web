const $ = id => document.getElementById(id);


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


// ============================================================================
// SVG plotting
// ============================================================================

function svgElement(name, attrs = {}) {
    const element = document.createElementNS(
        "http://www.w3.org/2000/svg",
        name
    );

    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, value);
    }

    return element;
}


function renderLinePlot(
    container,
    {
        title,
        xValues,
        series,
        xLabel,
        yLabel,
        xFormatter = value => String(value),
        yFormatter = value => Number(value).toFixed(3),
    }
) {
    container.innerHTML = "";

    if (
        !Array.isArray(xValues) ||
        xValues.length === 0 ||
        !Array.isArray(series) ||
        series.length === 0
    ) {
        container.innerHTML =
            '<p class="muted">No plot data available.</p>';
        return;
    }

    const validSeries = series.filter(
        s =>
            Array.isArray(s.values) &&
            s.values.length === xValues.length
    );

    if (validSeries.length === 0) {
        container.innerHTML =
            '<p class="muted">No plot data available.</p>';
        return;
    }


    const wrapper = document.createElement("div");
    wrapper.className = "analytics-plot";

    if (title) {
        const heading = document.createElement("h3");
        heading.textContent = title;
        wrapper.appendChild(heading);
    }


    const width = 900;
    const height = 420;

    const margin = {
        left: 75,
        right: 30,
        top: 30,
        bottom: 65,
    };

    const plotWidth =
        width - margin.left - margin.right;

    const plotHeight =
        height - margin.top - margin.bottom;


    const allY = validSeries
        .flatMap(s => s.values)
        .map(Number)
        .filter(Number.isFinite);

    const allX = xValues
        .map(Number)
        .filter(Number.isFinite);


    if (
        allX.length === 0 ||
        allY.length === 0
    ) {
        container.innerHTML =
            '<p class="muted">No numeric plot data available.</p>';
        return;
    }


    let xMin = Math.min(...allX);
    let xMax = Math.max(...allX);

    let yMin = Math.min(...allY);
    let yMax = Math.max(...allY);


    if (xMin === xMax) {
        xMin -= 1;
        xMax += 1;
    }

    if (yMin === yMax) {
        yMin -= 0.01;
        yMax += 0.01;
    }


    const yPadding =
        Math.max(
            (yMax - yMin) * 0.08,
            1e-6
        );

    yMin -= yPadding;
    yMax += yPadding;


    const xScale = value =>
        margin.left +
        (
            (value - xMin) /
            (xMax - xMin)
        ) * plotWidth;

    const yScale = value =>
        margin.top +
        plotHeight -
        (
            (value - yMin) /
            (yMax - yMin)
        ) * plotHeight;


    const svg = svgElement(
        "svg",
        {
            viewBox: `0 0 ${width} ${height}`,
            width: "100%",
            role: "img",
            "aria-label": title || "Analytics plot",
        }
    );


    // ------------------------------------------------------------------------
    // Grid + ticks
    // ------------------------------------------------------------------------

    const tickCount = 5;


    for (let i = 0; i <= tickCount; i++) {

        const fraction =
            i / tickCount;

        const xValue =
            xMin +
            fraction * (xMax - xMin);

        const x =
            xScale(xValue);


        svg.appendChild(
            svgElement(
                "line",
                {
                    x1: x,
                    y1: margin.top,
                    x2: x,
                    y2:
                        margin.top +
                        plotHeight,

                    stroke: "#e5e7eb",
                    "stroke-width": 1,
                }
            )
        );


        const label =
            svgElement(
                "text",
                {
                    x,
                    y:
                        margin.top +
                        plotHeight +
                        24,

                    "text-anchor": "middle",
                    "font-size": 12,
                    fill: "currentColor",
                }
            );

        label.textContent =
            xFormatter(xValue);

        svg.appendChild(label);
    }


    for (let i = 0; i <= tickCount; i++) {

        const fraction =
            i / tickCount;

        const yValue =
            yMin +
            fraction * (yMax - yMin);

        const y =
            yScale(yValue);


        svg.appendChild(
            svgElement(
                "line",
                {
                    x1: margin.left,
                    y1: y,
                    x2:
                        margin.left +
                        plotWidth,
                    y2: y,

                    stroke: "#e5e7eb",
                    "stroke-width": 1,
                }
            )
        );


        const label =
            svgElement(
                "text",
                {
                    x:
                        margin.left -
                        10,

                    y:
                        y + 4,

                    "text-anchor": "end",
                    "font-size": 12,
                    fill: "currentColor",
                }
            );

        label.textContent =
            yFormatter(yValue);

        svg.appendChild(label);
    }


    // ------------------------------------------------------------------------
    // Axes
    // ------------------------------------------------------------------------

    svg.appendChild(
        svgElement(
            "line",
            {
                x1: margin.left,
                y1:
                    margin.top +
                    plotHeight,

                x2:
                    margin.left +
                    plotWidth,

                y2:
                    margin.top +
                    plotHeight,

                stroke: "currentColor",
                "stroke-width": 1.5,
            }
        )
    );


    svg.appendChild(
        svgElement(
            "line",
            {
                x1: margin.left,
                y1: margin.top,

                x2: margin.left,
                y2:
                    margin.top +
                    plotHeight,

                stroke: "currentColor",
                "stroke-width": 1.5,
            }
        )
    );


    // ------------------------------------------------------------------------
    // Axis labels
    // ------------------------------------------------------------------------

    const xAxisLabel =
        svgElement(
            "text",
            {
                x:
                    margin.left +
                    plotWidth / 2,

                y:
                    height - 12,

                "text-anchor": "middle",
                "font-size": 13,
                fill: "currentColor",
            }
        );

    xAxisLabel.textContent =
        xLabel;

    svg.appendChild(xAxisLabel);


    const yAxisLabel =
        svgElement(
            "text",
            {
                x: 18,

                y:
                    margin.top +
                    plotHeight / 2,

                transform:
                    `rotate(-90 18 ${
                        margin.top +
                        plotHeight / 2
                    })`,

                "text-anchor": "middle",
                "font-size": 13,
                fill: "currentColor",
            }
        );

    yAxisLabel.textContent =
        yLabel;

    svg.appendChild(yAxisLabel);


    // ------------------------------------------------------------------------
    // Lines
    // ------------------------------------------------------------------------

    const strokes = [
        "#2563eb",
        "#dc2626",
        "#16a34a",
        "#9333ea",
    ];


    validSeries.forEach(
        (seriesEntry, seriesIndex) => {

            const points =
                xValues
                    .map(
                        (xValue, i) => {

                            const x =
                                Number(xValue);

                            const y =
                                Number(
                                    seriesEntry.values[i]
                                );

                            if (
                                !Number.isFinite(x) ||
                                !Number.isFinite(y)
                            ) {
                                return null;
                            }

                            return (
                                `${xScale(x)},` +
                                `${yScale(y)}`
                            );
                        }
                    )
                    .filter(Boolean)
                    .join(" ");


            const polyline =
                svgElement(
                    "polyline",
                    {
                        points,
                        fill: "none",

                        stroke:
                            strokes[
                                seriesIndex %
                                strokes.length
                            ],

                        "stroke-width": 2.2,
                        "stroke-linejoin": "round",
                        "stroke-linecap": "round",
                    }
                );


            if (seriesEntry.dashed) {
                polyline.setAttribute(
                    "stroke-dasharray",
                    "7 5"
                );
            }


            svg.appendChild(polyline);
        }
    );


    wrapper.appendChild(svg);


    // ------------------------------------------------------------------------
    // Legend
    // ------------------------------------------------------------------------

    if (validSeries.length > 1) {

        const legend =
            document.createElement("div");

        legend.style.display = "flex";
        legend.style.flexWrap = "wrap";
        legend.style.gap = "16px";
        legend.style.marginTop = "8px";


        validSeries.forEach(
            (entry, index) => {

                const item =
                    document.createElement("span");

                item.style.display = "inline-flex";
                item.style.alignItems = "center";
                item.style.gap = "6px";


                const swatch =
                    document.createElement("span");

                swatch.style.display =
                    "inline-block";

                swatch.style.width =
                    "22px";

                swatch.style.height =
                    "3px";

                swatch.style.background =
                    strokes[
                        index %
                        strokes.length
                    ];


                item.appendChild(swatch);

                item.appendChild(
                    document.createTextNode(
                        entry.label
                    )
                );

                legend.appendChild(item);
            }
        );


        wrapper.appendChild(legend);
    }


    container.appendChild(wrapper);
}


// ============================================================================
// Optimization history
// ============================================================================

async function renderHistory(url) {

    const container =
        $("history-figure");

    if (!container) {
        return;
    }


    if (!url) {

        container.innerHTML = `
            <p class="muted">
                Optimization history is not available for this point.
            </p>
        `;

        return;
    }


    const response =
        await fetch(url);


    if (!response.ok) {

        throw new Error(
            `Failed to load optimization history (${response.status})`
        );
    }


    const data =
        await response.json();


    if (
        !Array.isArray(
            data.fitness_history
        ) ||
        data.fitness_history.length === 0
    ) {

        container.innerHTML = `
            <p class="muted">
                Optimization history is empty.
            </p>
        `;

        return;
    }


    const generations =
        data.fitness_history.map(
            (_, index) =>
                index + 1
        );


    renderLinePlot(
        container,
        {
            title:
                "Optimization history",

            xValues:
                generations,

            series: [
                {
                    label: "Fitness",
                    values:
                        data.fitness_history,
                },
            ],

            xLabel:
                "Generation",

            yLabel:
                "Fitness",

            xFormatter:
                value =>
                    String(
                        Math.round(value)
                    ),
        }
    );


    if (
        data.plateau_generation !== null &&
        data.plateau_generation !== undefined
    ) {

        const plateau =
            document.createElement("p");

        plateau.className =
            "muted";

        plateau.textContent =
            `Plateau generation: ${data.plateau_generation}`;

        container.appendChild(
            plateau
        );
    }
}


// ============================================================================
// F-in / F-out
// ============================================================================

async function renderFinFout(url) {

    const container =
        $("fin-fout-figure");

    if (!container) {
        return;
    }


    if (!url) {

        container.innerHTML = `
            <p class="muted">
                F-in/F-out analysis is not available for this point.
            </p>
        `;

        return;
    }


    const response =
        await fetch(url);


    if (!response.ok) {

        throw new Error(
            `Failed to load F-in/F-out data (${response.status})`
        );
    }


    const data =
        await response.json();


    if (
        !Array.isArray(data.f_ins) ||
        data.f_ins.length === 0
    ) {

        container.innerHTML = `
            <p class="muted">
                F-in/F-out analysis is empty.
            </p>
        `;

        return;
    }


    container.innerHTML = "";


    // ------------------------------------------------------------------------
    // Fidelity plot
    // ------------------------------------------------------------------------

    const fidelityContainer =
        document.createElement("div");


    renderLinePlot(
        fidelityContainer,
        {
            title:
                "F-in / F-out",

            xValues:
                data.f_ins,
            series: [
                {
                    label:
                        "Noisy F-out",

                    values:
                        data.f_out_noise,
                },

                {
                    label:
                        "Clean F-out",

                    values:
                        data.f_out_clean,
                },

                {
                    label:
                        "F-out = F-in",

                    values:
                        data.f_ins,

                    dashed: true,
                },
            ],

            xLabel:
                "F-in",

            yLabel:
                "F-out",
        }
    );


    container.appendChild(
        fi[?12;2$ydelityContainer
    );


    // ------------------------------------------------------------------------
    // Success probability plot
    // ------------------------------------------------------------------------

    if (
        Array.isArray(
            data.success_noise
        ) &&
        Array.isArray(
            data.success_clean
        )
    ) {

        const successContainer =
            document.createElement("div");


        renderLinePlot(
            successContainer,
            {
                title:
                    "Success probability",

                xValues:
                    data.f_ins,

                series: [
                    {
                        label:
                            "Noisy",

                        values:
                            data.success_noise,
                    },

                    {
                        label:
                            "Clean",

                        values:
                            data.success_clean,
                    },
                ],

                xLabel:
                    "F-in",

                yLabel:
                    "Success probability",
            }
        );


        container.appendChild(
            successContainer
        );
    }


    if (
        data.num_simulations !== null &&
        data.num_simulations !== undefined
    ) {

        const simulations =
            document.createElement("p");

        simulations.className =
            "muted";

        simulations.textContent =
            `Simulations per point: ${data.num_simulations}`;

        container.appendChild(
            simulations
        );
    }
}


// ============================================================================
// Query
// ============================================================================

async function queryCircuit() {

    $("status").textContent =
        "Searching database...";

    $("results")
        .classList
        .add("hidden");


    // ------------------------------------------------------------------------
    // Pauli bias normalization
    // ------------------------------------------------------------------------

    const bx =
        number("bias_x");

    const by =
        number("bias_y");

    const bz =
        number("bias_z");


    if (
        ![bx, by, bz]
            .every(Number.isFinite)
    ) {

        $("status").textContent =
            "Error: Pauli bias values must be valid numbers.";

        return;
    }


    if (
        bx < 0 ||
        by < 0 ||
        bz < 0
    ) {

        $("status").textContent =
            "Error: Pauli bias values must be non-negative.";

        return;
    }


    const biasSum =
        bx + by + bz;


    if (biasSum <= 0) {

        $("status").textContent =
            "Error: At least one Pauli bias must be greater than zero.";

        return;
    }


    const payload = {

        number_registers:
            number(
                "number_registers"
            ),

        purified_pairs:
            number(
                "purified_pairs"
            ),

        evolution_metric:
            $(
                "evolution_metric"
            ).value,

        code_distance:
            number(
                "code_distance"
            ),

        network_fidelity:
            number(
                "network_fidelity"
            ),

        total_2q_error:
            number(
                "total_2q_error"
            ),

        measurement_flip:
            number(
                "measurement_flip"
            ),

        idle_lambda1:
            number(
                "idle_lambda1"
            ),

        idle_lambda2:
            number(
                "idle_lambda2"
            ),

        bias_x:
            bx / biasSum,

        bias_y:
            by / biasSum,

        bias_z:
            bz / biasSum,
    };


    try {

        const response =
            await fetch(
                "/api/query",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body:
                        JSON.stringify(
                            payload
                        ),
                }
            );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.error ||
                "Query failed"
            );
        }


        $("status").textContent =
            "";


        // --------------------------------------------------------------------
        // Nearest database match
        // --------------------------------------------------------------------

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
                ${Number(
                    result.distance
                ).toFixed(6)}
            </p>

            ${
                result.warning
                    ? `<p class="warning">${result.warning}</p>`
                    : ""
            }
        `;


        // --------------------------------------------------------------------
        // Requested vs matched environment
        // --------------------------------------------------------------------

        $("environment-comparison")
            .innerHTML =
                environmentTable(
                    result.requested,
                    result.matched
                );


        // --------------------------------------------------------------------
        // Saved performance
        // --------------------------------------------------------------------

        const p =
            result.performance;


        if (p) {

            $("performance").innerHTML = `
                <table>
                    <tbody>

                        <tr>
                            <td>
                                Logical qubit fidelity
                            </td>

                            <td>
                                ${Number(
                                    p.logical_qubit_fidelity
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>
                                Purified-pair fidelity
                            </td>

                            <td>
                                ${Number(
                                    p.purified_pairs_fidelity
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>
                                Average marginal fidelity
                            </td>

                            <td>
                                ${Number(
                                    p.average_marginal_fidelity
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>
                                Success probability
                            </td>

                            <td>
                                ${Number(
                                    p.success_probability
                                ).toFixed(6)}
                            </td>
                        </tr>

                        <tr>
                            <td>
                                Reliable
                            </td>

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


        // --------------------------------------------------------------------
        // Browser-rendered analytics
        // --------------------------------------------------------------------

        await renderHistory(
            result.assets?.history_data
        );


        await renderFinFout(
            result.assets?.fin_fout_data
        );


        $("results")
            .classList
            .remove("hidden");


    } catch (error) {

        $("status").textContent =
            `Error: ${error.message}`;
    }
}


$("query-button")
    .addEventListener(
        "click",
        queryCircuit
    );
