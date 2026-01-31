from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List

import pandas as pd
import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_values


@dataclass
class PostgresConfig:
    host: str
    port: int
    dbname: str
    user: str
    password: str
    schema: str
    table: str


class PostgresWriter:
    def __init__(self, config: PostgresConfig):
        self.config = config
        self.conn = psycopg2.connect(
            host=config.host,
            port=config.port,
            dbname=config.dbname,
            user=config.user,
            password=config.password,
        )
        self.conn.autocommit = True
        self._table_ready = False

    def close(self) -> None:
        if self.conn:
            self.conn.close()

    def insert_df(self, df: pd.DataFrame) -> None:
        if df.empty:
            return

        if not self._table_ready:
            self._ensure_table(df)
            self._table_ready = True

        clean_df = df.copy()
        for col in clean_df.select_dtypes(include=["object"]).columns:
            clean_df[col] = clean_df[col].apply(
                lambda value: None if pd.isna(value) else str(value)
            )
        clean_df = clean_df.where(pd.notna(clean_df), None)
        rows = list(clean_df.itertuples(index=False, name=None))
        columns = list(clean_df.columns)

        insert_stmt = sql.SQL("INSERT INTO {}.{} ({}) VALUES %s").format(
            sql.Identifier(self.config.schema),
            sql.Identifier(self.config.table),
            sql.SQL(", ").join(sql.Identifier(col) for col in columns),
        )

        with self.conn.cursor() as cur:
            execute_values(cur, insert_stmt.as_string(cur), rows)

    def _ensure_table(self, df: pd.DataFrame) -> None:
        columns = list(df.columns)
        column_defs = self._column_definitions(df, columns)

        create_schema_stmt = sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(
            sql.Identifier(self.config.schema)
        )
        create_table_stmt = sql.SQL(
            "CREATE TABLE IF NOT EXISTS {}.{} ({})"
        ).format(
            sql.Identifier(self.config.schema),
            sql.Identifier(self.config.table),
            sql.SQL(", ").join(column_defs),
        )

        with self.conn.cursor() as cur:
            cur.execute(create_schema_stmt)
            cur.execute(create_table_stmt)

    def _column_definitions(
        self, df: pd.DataFrame, columns: Iterable[str]
    ) -> List[sql.SQL]:
        definitions: List[sql.SQL] = []
        for col in columns:
            dtype = df[col].dtype
            pg_type = self._map_dtype(dtype)
            definitions.append(
                sql.SQL("{} {}").format(sql.Identifier(col), sql.SQL(pg_type))
            )
        return definitions

    @staticmethod
    def _map_dtype(dtype) -> str:
        if pd.api.types.is_integer_dtype(dtype):
            return "BIGINT"
        if pd.api.types.is_float_dtype(dtype):
            return "DOUBLE PRECISION"
        if pd.api.types.is_bool_dtype(dtype):
            return "BOOLEAN"
        if pd.api.types.is_datetime64_any_dtype(dtype):
            return "TIMESTAMPTZ"
        return "TEXT"
