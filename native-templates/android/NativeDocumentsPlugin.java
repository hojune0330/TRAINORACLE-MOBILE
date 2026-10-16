package __APP_ID__;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.OutputStream;
import java.util.Arrays;

@CapacitorPlugin(name = "NativeDocuments")
public class NativeDocumentsPlugin extends Plugin {
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private byte[] pendingBytes;
    private Dialog documentDialog;

    private static boolean safePath(String p, boolean html) {
        if (p == null || p.isEmpty() || p.length() > 2048 || p.startsWith("/") || p.contains("%") || p.contains("\\")) return false;
        for (String part : p.split("/", -1)) {
            if (part.equals(".") || part.equals("..") || !part.matches("[A-Za-z0-9_-][A-Za-z0-9_.-]*")) return false;
        }
        return !html || p.toLowerCase(java.util.Locale.ROOT).endsWith(".html");
    }

    private static boolean safeFilename(String value) {
        if (value == null || value.isEmpty() || value.length() > 255 || value.equals(".") || value.equals("..")) return false;
        for (char c : value.toCharArray()) if (c < 32 || c == 127 || c == 47 || c == 92) return false;
        return true;
    }
    private static boolean safeBase64(String value) {
        if (value == null || value.length() > ((MAX_BYTES + 2) / 3) * 4 || value.length() % 4 != 0) return false;
        int padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        for (int i = 0; i < value.length() - padding; i++) {
            char c = value.charAt(i);
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/')) return false;
        }
        return value.isEmpty() || value.length() >= 4;
    }
    private static boolean safeExternal(String value) {
        if (value == null) return false;
        for (char c : value.toCharArray()) if (c <= 32 || c == 92) return false;
        if (value.toLowerCase(java.util.Locale.ROOT).matches(".*%0[ad].*")) return false;
        Uri u = Uri.parse(value);
        return ("https".equals(u.getScheme()) && u.getHost() != null && !u.getHost().isEmpty() && u.getUserInfo() == null)
            || ("mailto".equals(u.getScheme()) && u.getSchemeSpecificPart() != null && !u.getSchemeSpecificPart().isEmpty());
    }

    @PluginMethod
    public void saveDocument(PluginCall call) {
        String filename = call.getString("filename");
        String mime = call.getString("mimeType");
        String encoded = call.getString("dataBase64");
        if (!safeFilename(filename)) { call.reject("INVALID_FILENAME"); return; }
        if (!("application/json".equals(mime) || "image/png".equals(mime)) || !safeBase64(encoded)) { call.reject("INVALID_DOCUMENT"); return; }
        byte[] bytes;
        try { bytes = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException error) { call.reject("INVALID_DOCUMENT"); return; }
        if (bytes.length > MAX_BYTES) { call.reject("TOO_LARGE"); return; }
        synchronized (this) {
            if (pendingBytes != null) { call.reject("BUSY"); return; }
            pendingBytes = bytes;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        try { startActivityForResult(call, intent, "documentResult"); }
        catch (Exception error) { clearPending(); call.reject("PICKER_UNAVAILABLE"); }
    }

    private synchronized void clearPending() {
        if (pendingBytes != null) Arrays.fill(pendingBytes, (byte) 0);
        pendingBytes = null;
    }

    @ActivityCallback
    private void documentResult(PluginCall call, ActivityResult result) {
        if (call == null) { clearPending(); return; }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            clearPending(); JSObject reply = new JSObject(); reply.put("status", "cancelled"); call.resolve(reply); return;
        }
        Uri uri = result.getData().getData();
        try {
            if (pendingBytes == null) { call.reject("NO_PENDING_DOCUMENT"); return; }
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) {
                if (output == null) throw new java.io.IOException();
                output.write(pendingBytes); output.flush();
            }
            JSObject reply = new JSObject(); reply.put("status", "saved"); call.resolve(reply);
        } catch (Exception error) { call.reject("SAVE_FAILED"); }
        finally { clearPending(); }
    }

    private void launchExternal(String value) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(value));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        getActivity().startActivity(intent);
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String value = call.getString("url");
        if (!safeExternal(value)) { call.reject("UNSAFE_URL"); return; }
        getActivity().runOnUiThread(() -> {
            try { launchExternal(value); call.resolve(); }
            catch (Exception error) { call.reject("NO_HANDLER"); }
        });
    }

    @PluginMethod
    public void openLocalDocument(PluginCall call) {
        String p = call.getString("path");
        if (!safePath(p, true)) { call.reject("UNSAFE_PATH"); return; }
        try (java.io.InputStream ignored = getContext().getAssets().open("public/" + p)) {}
        catch (Exception error) { call.reject("DOCUMENT_NOT_FOUND"); return; }
        getActivity().runOnUiThread(() -> {
            if (documentDialog != null) { call.reject("BUSY"); return; }
            Dialog dialog = new Dialog(getActivity()); documentDialog = dialog;
            LinearLayout layout = new LinearLayout(getActivity()); layout.setOrientation(LinearLayout.VERTICAL);
            Button close = new Button(getActivity()); close.setText("닫기");
            WebView view = new WebView(getActivity());
            view.getSettings().setJavaScriptEnabled(false);
            view.getSettings().setDomStorageEnabled(false);
            view.getSettings().setAllowFileAccess(false);
            view.getSettings().setAllowContentAccess(false);
            view.getSettings().setBlockNetworkLoads(true);
            view.getSettings().setSupportMultipleWindows(false);
            view.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                    String value = request.getUrl().toString();
                    if (request.hasGesture() && safeExternal(value)) {
                        try { launchExternal(value); } catch (Exception ignored) {}
                    }
                    return true;
                }
                @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                    String value = request.getUrl().toString();
                    String prefix = "file:///android_asset/public/";
                    if (value.startsWith(prefix) && safePath(value.substring(prefix.length()), false)) return null;
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
            });
            layout.addView(close); layout.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
            dialog.setContentView(layout);
            close.setOnClickListener(v -> dialog.dismiss());
            dialog.setOnDismissListener(d -> { view.stopLoading(); view.destroy(); documentDialog = null; });
            dialog.show();
            if (dialog.getWindow() != null) dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            view.loadUrl("file:///android_asset/public/" + p); call.resolve();
        });
    }

    @Override protected void handleOnDestroy() {
        clearPending();
        if (documentDialog != null) documentDialog.dismiss();
    }
}
