package org.quire.editor;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Hands documents that other apps open or share with Quire ("Open with", "Share") to the page,
 * as {name, path, size} (a copy in Quire's cache, which the page reads and deletes) or {name, error}.
 */
@CapacitorPlugin(name = "QuireIntent")
public class QuireIntentPlugin extends Plugin {
    private static final long MAX_BYTES = 200L * 1024 * 1024; // the page couldn't hold much more anyway
    private static final String INCOMING = "incoming";
    private JSObject pending; // the file Quire was started with, until the page asks for it

    @Override
    public void load() {
        clearIncoming();
        pending = fileFrom(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject file = fileFrom(intent);
        if (file != null) notifyListeners("file", file, true);
    }

    @PluginMethod
    public void takeLaunchFile(PluginCall call) {
        JSObject result = new JSObject();
        result.put("file", pending);
        pending = null;
        call.resolve(result);
    }

    /**
     * Copy the shared document into Quire's cache, 64 KB at a time, and return where it is. The bytes are
     * never held in Java memory: base64 text of a 22 MB PDF took ~150 MB and crashed (Java's limit is 256 MB).
     */
    @SuppressWarnings("deprecation") // getParcelableExtra(String) is what API 24–32 have
    private JSObject fileFrom(Intent intent) {
        if (intent == null) return null;
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return null;
        JSObject file = new JSObject();
        file.put("name", nameOf(uri));
        File dir = new File(getContext().getCacheDir(), INCOMING);
        File copy = new File(dir, System.nanoTime() + ".bin"); // the page reads it, then deletes it
        try {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Quire couldn't make room for it");
            long total = 0;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 OutputStream out = new FileOutputStream(copy)) {
                if (in == null) throw new IOException("the other app didn't give the file");
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) {
                    total += n;
                    if (total > MAX_BYTES) throw new IOException("it is larger than 200 MB");
                    out.write(buffer, 0, n);
                }
            }
            file.put("path", copy.getAbsolutePath());
            file.put("size", total);
        } catch (Exception e) {
            copy.delete();
            file.put("error", e.getMessage() == null ? "it couldn't be read" : e.getMessage());
        }
        return file;
    }

    /** Copies left by an earlier run (the page deletes each one after reading it, unless Quire was closed first). */
    private void clearIncoming() {
        File[] old = new File(getContext().getCacheDir(), INCOMING).listFiles();
        if (old != null) for (File f : old) f.delete();
    }

    private String nameOf(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {
            // some apps don't answer; fall back to the link's last part
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "document.pdf";
    }
}
