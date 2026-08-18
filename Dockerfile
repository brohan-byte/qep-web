FROM julia:1.12

WORKDIR /app

COPY Project.toml Manifest.toml ./
ENV JULIA_PKG_PRECOMPILE_AUTO=0
RUN julia --project=. -e 'using Pkg; Pkg.instantiate()'

COPY . .

ENV WEB_HOST=0.0.0.0

CMD ["julia", "--project=.", "web/server.jl"]
