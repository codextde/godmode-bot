package expo.modules.pasteinput

import android.content.ClipData
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.view.inputmethod.InputMethodManager
import android.webkit.MimeTypeMap
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Executors

class PasteInputModule : Module() {
  private var target: WeakReference<EditText>? = null
  private val io = Executors.newSingleThreadExecutor()

  private val listener = OnReceiveContentListener { view, payload ->
    val split = payload.partition { item: ClipData.Item -> item.uri != null }
    split.first?.let { receive(view.context, it) }
    split.second
  }

  override fun definition() = ModuleDefinition {
    Name("PasteInput")

    Events("onPaste")

    Function("setActive") { active: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        detach()
        if (active) (activity.currentFocus as? EditText)?.let { attach(it) }
      }
    }

    OnDestroy {
      io.shutdown()
    }
  }

  private fun attach(view: EditText) {
    ViewCompat.setOnReceiveContentListener(view, MIME_TYPES, listener)
    target = WeakReference(view)
    restartInput(view)
  }

  private fun detach() {
    val view = target?.get() ?: return
    target = null
    ViewCompat.setOnReceiveContentListener(view, null, null)
    restartInput(view)
  }

  private fun restartInput(view: EditText) {
    val imm = view.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.restartInput(view)
  }

  private fun receive(context: Context, content: ContentInfoCompat) {
    val clip = content.clip
    val described = (0 until clip.description.mimeTypeCount).map { clip.description.getMimeType(it) }
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    io.execute {
      val dir = File(context.cacheDir, "pasted/${UUID.randomUUID()}").apply { mkdirs() }
      val files = uris.mapIndexedNotNull { index, uri -> store(context, uri, described.getOrNull(index) ?: described.firstOrNull(), index, dir) }
      if (files.isNotEmpty()) sendEvent("onPaste", mapOf("files" to files))
    }
  }

  private fun store(context: Context, uri: Uri, described: String?, index: Int, dir: File): Map<String, Any>? {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri)?.takeIf { it != "application/octet-stream" }
      ?: described?.takeIf { !it.startsWith("text/") }
      ?: "application/octet-stream"
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
    val shown = displayName(context, uri)?.replace('/', '-')
    val fallback = (if (mime.startsWith("image/")) "pasted-image-${index + 1}" else "pasted-file-${index + 1}") + (ext?.let { ".$it" } ?: "")
    var name = shown?.takeIf { it.isNotBlank() } ?: fallback
    if (!name.contains('.') && ext != null) name = "$name.$ext"
    var dest = File(dir, name)
    if (dest.exists()) dest = File(dir, "${index + 1}-$name")
    return try {
      val input = resolver.openInputStream(uri) ?: return null
      input.use { source -> dest.outputStream().use { source.copyTo(it) } }
      mapOf("uri" to Uri.fromFile(dest).toString(), "name" to dest.name, "mime" to mime, "size" to dest.length().toDouble())
    } catch (_: Exception) {
      dest.delete()
      null
    }
  }

  private fun displayName(context: Context, uri: Uri): String? = try {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else null
    }
  } catch (_: Exception) {
    null
  }

  companion object {
    private val MIME_TYPES = arrayOf("image/*", "video/*", "audio/*", "application/*")
  }
}
