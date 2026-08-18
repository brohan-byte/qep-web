FROM julia:1.12

WORKDIR /app

COPY Project.toml Manifest.toml ./

RUN julia --project=. -e 'using Pkg; Pkg.instantiate(); Pkg.precompile()'

COPY . .

ENV WEB_HOST=0.0.0.0

CMD ["julia", "--project=.", "web/server.jl"]
