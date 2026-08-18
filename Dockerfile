FROM julia:1.12

WORKDIR /app

ENV JULIA_NUM_THREADS=1
ENV JULIA_PKG_PRECOMPILE_AUTO=0

COPY Project.toml Manifest.toml ./

RUN julia --project=. -e 'using Pkg; Pkg.instantiate()'

COPY . .

ENV WEB_HOST=0.0.0.0

CMD ["julia", "--startup-file=no", "--project=.", "web/server.jl"]
