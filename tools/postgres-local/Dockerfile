FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      postgresql-16-postgis-3 \
      postgresql-16-postgis-3-scripts \
      postgresql-16-pgvector \
      postgresql-16-cron \
      postgresql-contrib-16 \
    && rm -rf /var/lib/apt/lists/* \
    && echo "shared_preload_libraries = 'pg_cron'" >> /usr/share/postgresql/postgresql.conf.sample \
    && echo "cron.database_name = 'postgres'" >> /usr/share/postgresql/postgresql.conf.sample
