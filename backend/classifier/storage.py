"""
Classifier Storage Module
Handles MySQL persistence for the audio classifier dataset.
Tables: classifier_dataset, classifier_resumen
"""
import os
import json

import pymysql
import pymysql.cursors

DB_HOST = os.getenv("DB_HOST", "app-studio_db")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASS = os.getenv("DB_PASS", "")
DB_NAME = os.getenv("DB_NAME", "studio_db")


def _get_conn():
    return pymysql.connect(
        host=DB_HOST, port=DB_PORT,
        user=DB_USER, password=DB_PASS,
        database=DB_NAME,
        cursorclass=pymysql.cursors.DictCursor,
        charset="utf8mb4",
        autocommit=True,
    )


def ensure_tables():
    """Create classifier tables if they don't exist, run column migrations."""
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            # ── classifier_dataset ────────────────────────────────
            cur.execute("""
                CREATE TABLE IF NOT EXISTS classifier_dataset (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    segmento ENUM('intro', 'meditacion', 'afirmaciones') NOT NULL,
                    language_code VARCHAR(10) NOT NULL DEFAULT 'es',
                    texto_original TEXT NOT NULL,
                    texto_transcrito TEXT,
                    coincidencia_texto FLOAT,
                    duracion_seg FLOAT,
                    wpm FLOAT,
                    densidad_silencios FLOAT,
                    duracion_promedio_silencio_seg FLOAT,
                    energia_promedio FLOAT,
                    variacion_pitch FLOAT,
                    jitter FLOAT,
                    shimmer FLOAT,
                    spectral_centroid FLOAT,
                    nisqa_score FLOAT,
                    energia_max FLOAT,
                    energia_min FLOAT,
                    params_elevenlabs JSON,
                    decision ENUM('aprobado', 'rechazado') NOT NULL,
                    calidad_score INT,
                    razon_rechazo JSON,
                    intento_numero INT DEFAULT 1,
                    numero_ejemplos_al_momento INT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_user_segmento (user_id, segmento),
                    INDEX idx_user_segmento_lang (user_id, segmento, language_code),
                    INDEX idx_decision (decision)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            # ── classifier_resumen ────────────────────────────────
            cur.execute("""
                CREATE TABLE IF NOT EXISTS classifier_resumen (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    segmento ENUM('intro', 'meditacion', 'afirmaciones') NOT NULL,
                    language_code VARCHAR(10) NOT NULL DEFAULT 'es',
                    version INT DEFAULT 1,
                    ejemplos_procesados INT DEFAULT 0,
                    resumen_json JSON,
                    umbral_actual ENUM('sin_datos', 'aceptable', 'bueno', 'excelente', 'pro') DEFAULT 'sin_datos',
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_user_seg_lang (user_id, segmento, language_code)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            # ── Migrations: add missing columns ───────────────────
            _add_column_if_missing(cur, "classifier_dataset", "language_code",
                "VARCHAR(10) NOT NULL DEFAULT 'es' AFTER segmento")
            _add_column_if_missing(cur, "classifier_dataset", "wpm",
                "FLOAT DEFAULT NULL AFTER coincidencia_texto")
            _add_column_if_missing(cur, "classifier_dataset", "densidad_silencios",
                "FLOAT DEFAULT NULL AFTER wpm")
            _add_column_if_missing(cur, "classifier_dataset", "jitter",
                "FLOAT DEFAULT NULL AFTER variacion_pitch")
            _add_column_if_missing(cur, "classifier_dataset", "shimmer",
                "FLOAT DEFAULT NULL AFTER jitter")
            _add_column_if_missing(cur, "classifier_dataset", "spectral_centroid",
                "FLOAT DEFAULT NULL AFTER shimmer")
            _add_column_if_missing(cur, "classifier_dataset", "nisqa_score",
                "FLOAT DEFAULT NULL AFTER spectral_centroid")
            _add_column_if_missing(cur, "classifier_dataset", "calidad_score",
                "INT DEFAULT NULL AFTER decision")
            _add_column_if_missing(cur, "classifier_dataset", "razon_rechazo",
                "JSON DEFAULT NULL AFTER calidad_score")

            # add language_code index if missing
            _add_index_if_missing(cur, "classifier_dataset", "idx_user_segmento_lang",
                "(user_id, segmento, language_code)")

            # classifier_resumen migrations
            _add_column_if_missing(cur, "classifier_resumen", "language_code",
                "VARCHAR(10) NOT NULL DEFAULT 'es' AFTER segmento")
            try:
                cur.execute("ALTER TABLE classifier_resumen DROP INDEX unique_user_segmento")
            except Exception:
                pass
            _add_unique_if_missing(cur, "classifier_resumen", "unique_user_seg_lang",
                "(user_id, segmento, language_code)")

        conn.close()
    except Exception as e:
        print(f"[classifier.storage] DB init warning: {e}")


def _add_column_if_missing(cur, table: str, column: str, definition: str):
    cur.execute("""
        SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s
    """, (table, column))
    if cur.fetchone()["cnt"] == 0:
        try:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        except Exception as e:
            print(f"[classifier.storage] migration add {column} to {table}: {e}")


def _add_index_if_missing(cur, table: str, index_name: str, columns: str):
    cur.execute("""
        SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s
    """, (table, index_name))
    if cur.fetchone()["cnt"] == 0:
        try:
            cur.execute(f"ALTER TABLE {table} ADD INDEX {index_name} {columns}")
        except Exception:
            pass


def _add_unique_if_missing(cur, table: str, index_name: str, columns: str):
    cur.execute("""
        SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s
    """, (table, index_name))
    if cur.fetchone()["cnt"] == 0:
        try:
            cur.execute(f"ALTER TABLE {table} ADD UNIQUE KEY {index_name} {columns}")
        except Exception:
            pass


def _compute_umbral(n: int) -> str:
    if n < 30:    return "sin_datos"
    if n < 75:    return "aceptable"
    if n < 150:   return "bueno"
    if n < 300:   return "excelente"
    return "pro"


def _siguiente_umbral_info(n: int) -> dict:
    if n < 30:    return {"nombre": "aceptable",  "faltan": 30  - n, "total": 30}
    if n < 75:    return {"nombre": "bueno",       "faltan": 75  - n, "total": 75}
    if n < 150:   return {"nombre": "excelente",   "faltan": 150 - n, "total": 150}
    if n < 300:   return {"nombre": "pro",         "faltan": 300 - n, "total": 300}
    return {"nombre": "pro", "faltan": 0, "total": 300}


def guardar_ejemplo(
    user_id: int,
    segmento: str,
    datos_features: dict,
    decision: str,
    intento: int = 1,
    params_elevenlabs: dict = None,
    language_code: str = "es",
    calidad_score: int = None,
    razon_rechazo: list = None,
) -> bool:
    """Save a training example to the dataset."""
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS cnt FROM classifier_dataset "
                "WHERE user_id=%s AND segmento=%s AND language_code=%s",
                (user_id, segmento, language_code),
            )
            row = cur.fetchone()
            n_actual = (row["cnt"] if row else 0) + 1

            decision_norm = "aprobado" if decision in ("ok", "aprobado") else "rechazado"

            cur.execute(
                """
                INSERT INTO classifier_dataset
                (user_id, segmento, language_code,
                 texto_original, texto_transcrito, coincidencia_texto,
                 duracion_seg, wpm, densidad_silencios, duracion_promedio_silencio_seg,
                 energia_promedio, variacion_pitch,
                 jitter, shimmer, spectral_centroid, nisqa_score,
                 energia_max, energia_min,
                 params_elevenlabs,
                 decision, calidad_score, razon_rechazo,
                 intento_numero, numero_ejemplos_al_momento)
                VALUES (%s,%s,%s, %s,%s,%s, %s,%s,%s,%s, %s,%s, %s,%s,%s,%s, %s,%s, %s, %s,%s,%s, %s,%s)
                """,
                (
                    user_id, segmento, language_code,
                    datos_features.get("texto_original", ""),
                    datos_features.get("texto_transcrito"),
                    datos_features.get("coincidencia_texto"),
                    datos_features.get("duracion_seg"),
                    datos_features.get("wpm"),
                    datos_features.get("densidad_silencios"),
                    datos_features.get("duracion_promedio_silencio_seg"),
                    datos_features.get("energia_promedio"),
                    datos_features.get("variacion_pitch"),
                    datos_features.get("jitter"),
                    datos_features.get("shimmer"),
                    datos_features.get("spectral_centroid"),
                    datos_features.get("nisqa_score"),
                    datos_features.get("energia_max"),
                    datos_features.get("energia_min"),
                    json.dumps(params_elevenlabs or {}),
                    decision_norm,
                    calidad_score,
                    json.dumps(razon_rechazo) if razon_rechazo else None,
                    intento,
                    n_actual,
                ),
            )

            umbral = _compute_umbral(n_actual)
            cur.execute(
                """
                INSERT INTO classifier_resumen (user_id, segmento, language_code, ejemplos_procesados, umbral_actual)
                VALUES (%s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    ejemplos_procesados = %s,
                    umbral_actual = %s
                """,
                (user_id, segmento, language_code, n_actual, umbral, n_actual, umbral),
            )
        conn.close()
        return True
    except Exception as e:
        print(f"[classifier.storage] guardar_ejemplo error: {e}")
        return False


def obtener_conteo_por_segmento(user_id: int, language_code: str = "es") -> dict:
    """Returns {intro: n, meditacion: n, afirmaciones: n} for the given language."""
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT segmento, COUNT(*) AS cnt FROM classifier_dataset "
                "WHERE user_id=%s AND language_code=%s GROUP BY segmento",
                (user_id, language_code),
            )
            rows = cur.fetchall()
        conn.close()
        conteos = {"intro": 0, "meditacion": 0, "afirmaciones": 0}
        for row in rows:
            if row["segmento"] in conteos:
                conteos[row["segmento"]] = row["cnt"]
        return conteos
    except Exception:
        return {"intro": 0, "meditacion": 0, "afirmaciones": 0}


def obtener_umbral(user_id: int, segmento: str, language_code: str = "es") -> str:
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT umbral_actual FROM classifier_resumen "
                "WHERE user_id=%s AND segmento=%s AND language_code=%s",
                (user_id, segmento, language_code),
            )
            row = cur.fetchone()
        conn.close()
        return row["umbral_actual"] if row else "sin_datos"
    except Exception:
        return "sin_datos"


def obtener_ejemplos_para_resumen(
    user_id: int, segmento: str, limit: int = 200, language_code: str = "es"
) -> list:
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT texto_original, texto_transcrito, coincidencia_texto,
                       duracion_seg, wpm, densidad_silencios,
                       duracion_promedio_silencio_seg,
                       energia_promedio, variacion_pitch,
                       jitter, shimmer, spectral_centroid, nisqa_score,
                       energia_max, energia_min,
                       decision, calidad_score, razon_rechazo, intento_numero
                FROM classifier_dataset
                WHERE user_id=%s AND segmento=%s AND language_code=%s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (user_id, segmento, language_code, limit),
            )
            rows = cur.fetchall()
        conn.close()
        return rows or []
    except Exception:
        return []


def guardar_resumen(
    user_id: int, segmento: str, resumen_json: dict, version: int, language_code: str = "es"
) -> bool:
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            n = resumen_json.get("ejemplos_procesados", 0)
            umbral = _compute_umbral(n)
            cur.execute(
                """
                INSERT INTO classifier_resumen
                    (user_id, segmento, language_code, version, resumen_json, ejemplos_procesados, umbral_actual)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                    version             = %s,
                    resumen_json        = %s,
                    ejemplos_procesados = %s,
                    umbral_actual       = %s
                """,
                (
                    user_id, segmento, language_code, version, json.dumps(resumen_json), n, umbral,
                    version, json.dumps(resumen_json), n, umbral,
                ),
            )
        conn.close()
        return True
    except Exception as e:
        print(f"[classifier.storage] guardar_resumen error: {e}")
        return False


def obtener_resumen(user_id: int, segmento: str, language_code: str = "es") -> dict | None:
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT resumen_json, version, ejemplos_procesados, umbral_actual "
                "FROM classifier_resumen WHERE user_id=%s AND segmento=%s AND language_code=%s",
                (user_id, segmento, language_code),
            )
            row = cur.fetchone()
        conn.close()
        if not row or not row.get("resumen_json"):
            return None
        resumen = row["resumen_json"]
        if isinstance(resumen, str):
            resumen = json.loads(resumen)
        resumen["_version"] = row["version"]
        resumen["_umbral"]  = row["umbral_actual"]
        return resumen
    except Exception:
        return None


def obtener_status_completo(user_id: int, language_code: str = "es") -> dict:
    """Returns full learning status for all segments in the given language."""
    try:
        conteos = obtener_conteo_por_segmento(user_id, language_code)
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT segmento, umbral_actual, version FROM classifier_resumen "
                "WHERE user_id=%s AND language_code=%s",
                (user_id, language_code),
            )
            rows = cur.fetchall()
        conn.close()

        umbrales  = {r["segmento"]: r["umbral_actual"] for r in rows}
        versiones = {r["segmento"]: r["version"]       for r in rows}

        resultado = {}
        for seg in ("intro", "meditacion", "afirmaciones"):
            n = conteos.get(seg, 0)
            resultado[seg] = {
                "ejemplos":        n,
                "umbral":          umbrales.get(seg, _compute_umbral(n)),
                "version_resumen": versiones.get(seg, 0),
                "siguiente_umbral": _siguiente_umbral_info(n),
            }
        return resultado
    except Exception as e:
        print(f"[classifier.storage] obtener_status error: {e}")
        return {}


def borrar_segmento(user_id: int, segmento: str, language_code: str = "es") -> dict:
    """Delete all training data and summary for a user/segment/language."""
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM classifier_dataset WHERE user_id=%s AND segmento=%s AND language_code=%s",
                (user_id, segmento, language_code),
            )
            deleted_ejemplos = cur.rowcount
            cur.execute(
                "DELETE FROM classifier_resumen WHERE user_id=%s AND segmento=%s AND language_code=%s",
                (user_id, segmento, language_code),
            )
            deleted_resumen = cur.rowcount
        conn.close()
        return {"ejemplos": deleted_ejemplos, "resumen": deleted_resumen}
    except Exception as e:
        print(f"[classifier.storage] borrar_segmento error: {e}")
        return {"ejemplos": 0, "resumen": 0}


# Create tables on first import
ensure_tables()
