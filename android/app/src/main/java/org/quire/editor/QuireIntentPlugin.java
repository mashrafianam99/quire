package org.quire.editor;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Hands documents that other apps open or share with Quire ("Open with", "Share") to the page,
 * as {name, data (base64)} or {name, error}.
 */
@CapacitorPlugin(name = "QuireIntent")
public class QuireIntentPlugin extends Plugin {
    private static final long MAX_BYTES = 100L * 1024 * 1024; // the page couldn't hold much more anyway
    private JSObject pending; // the file Quire was started with, until the page asks for it

    @Override
    public void load() {
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

    @SuppressWarnings("deprecation") // getParcelableExtra(String) is what API 24–32 have
    private JSObject fileFrom(Intent intent) {
        if (intent == null) return null;
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return null;
        JSObject file = new JSObject();
        file.put("name", nameOf(uri));
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new java.io.IOException("the other app didn't give the file");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            for (int n; (n = in.read(buffer)) > 0; ) {
                total += n;
                if (total > MAX_BYTES) {
                    file.put("error", "it is larger than 100 MB");
                    return file;
                }
                out.write(buffer, 0, n);
            }
            file.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        } catch (Exception e) {
            file.put("error", e.getMessage() == null ? "it couldn't be read" : e.getMessage());
        }
        return file;
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
