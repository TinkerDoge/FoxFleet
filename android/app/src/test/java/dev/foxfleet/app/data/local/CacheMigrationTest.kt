package dev.foxfleet.app.data.local

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * The exported schema JSON (app/schemas) is the migration contract. For every version the app shipped, this builds that
 * version's database straight from its JSON (tables, indices, Room's identity row), then opens it with the current
 * [CacheDb] WITHOUT the destructive fallback: Room runs the migrations and validates every table against the current
 * entities, so a missing or wrong migration fails here instead of quietly wiping users' caches.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CacheMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val dir = listOf("schemas", "app/schemas").map { File(it, CacheDb::class.java.name) }.first { it.isDirectory }
    private fun schema(v: Int): JsonObject = Json.parseToJsonElement(File(dir, "$v.json").readText()).jsonObject["database"]!!.jsonObject

    /** Creates [name] exactly as Room [v] would have, from the exported JSON. */
    private fun createFromSchema(name: String, v: Int) {
        val file = context.getDatabasePath(name).also { it.parentFile?.mkdirs(); it.delete() }
        val s = schema(v)
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            for (e in s["entities"]!!.jsonArray) {
                val t = e.jsonObject; val table = t["tableName"]!!.jsonPrimitive.content
                db.execSQL(t["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table))
                t["indices"]?.jsonArray?.forEach { i -> db.execSQL(i.jsonObject["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table)) }
            }
            s["setupQueries"]?.jsonArray?.forEach { db.execSQL(it.jsonPrimitive.content) }
            db.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, '${s["identityHash"]!!.jsonPrimitive.content}')")
            db.version = v
        }
    }

    @Test fun everyVersionHasAnExportedSchema() {
        for (v in 1..CacheDb.VERSION) assertTrue("schema $v.json missing: run a build to export it", File(dir, "$v.json").isFile)
        assertEquals(CacheDb.VERSION, schema(CacheDb.VERSION)["version"]!!.jsonPrimitive.content.toInt())
    }

    @Test fun v1MessagesSurviveTheMoveToV2() = runBlocking {
        createFromSchema("keep.db", 1)
        SQLiteDatabase.openDatabase(context.getDatabasePath("keep.db").path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL("INSERT INTO messages (owner, agent, chat_id, msg_key, hub_id, ord, ts, role, content, reasoning, steps, images, kind) VALUES ('o','nova','c','id:m1','m1',0,5,'user','kept','','','','user')")
            db.execSQL("INSERT INTO chat_meta (owner, agent, chat_id, older_offset, has_older, synced_at) VALUES ('o','nova','c',80,1,1)")
        }
        val db = CacheDb.build(context, "keep.db", destructive = false)
        try {
            val c = ChatCache(db, "o").open("nova", "c")!!
            assertEquals(listOf("kept"), c.messages.map { it.content }); assertEquals(null, c.messages[0].n)
            assertTrue(db.live().chatRows("o", false).isEmpty())
        } finally { db.close() }
    }

    @Test fun v2CursorSurvivesTheMoveToV3WithNothingOwed() = runBlocking {
        createFromSchema("keep3.db", 2)
        SQLiteDatabase.openDatabase(context.getDatabasePath("keep3.db").path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL("INSERT INTO sync_state (owner, cursor, total_unread, total_unread_all, synced_at) VALUES ('o','s1:77',3,4,1)")
        }
        val db = CacheDb.build(context, "keep3.db", destructive = false)
        try {
            val row = ChatCache(db, "o").sync()!!
            assertEquals("s1:77", row.cursor); assertEquals(3, row.totalUnread); assertEquals(null, row.owedResync)
        } finally { db.close() }
    }

    @Test fun everyShippedVersionMigratesToCurrentAndValidates() = runBlocking {
        for (v in 1..CacheDb.VERSION) {
            val name = "migrate-$v.db"; createFromSchema(name, v)
            val db = CacheDb.build(context, name, destructive = false)
            try { db.openHelper.writableDatabase; assertEquals(CacheDb.VERSION, db.openHelper.readableDatabase.version); db.admin().wipeAll() } finally { db.close() }
        }
    }
}
