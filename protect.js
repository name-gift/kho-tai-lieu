
"use strict";

(() => {
    if (window.__pageProtectionStarted) return;
    window.__pageProtectionStarted = true;

    const API_URL =
        "https://api-quiz.abcd1601ab.workers.dev/";

    const DEVICE_KEY = "kho_tai_lieu_device_id_v1";

    function getDeviceId() {
        let id = localStorage.getItem(DEVICE_KEY);

        if (!id) {
            id = crypto.randomUUID();
            localStorage.setItem(DEVICE_KEY, id);
        }

        return id;
    }

    const deviceId = getDeviceId();

    let locked = false;
    let checking = false;

    // Không hiển thị màn hình khóa, không tự tải lại.
    function showLockedScreen() {
        locked = true;
    }

    async function apiRequest(action, extra = {}) {
        const url = new URL(API_URL);

        url.searchParams.set("action", action);
        url.searchParams.set("deviceId", deviceId);
        url.searchParams.set("_refresh", Date.now());

        Object.entries(extra).forEach(([key, value]) => {
            url.searchParams.set(key, String(value));
        });

        const response = await fetch(url.toString(), {
            method: "GET",
            cache: "no-store",
            headers: {
                Accept: "application/json"
            }
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error("Worker không trả JSON hợp lệ.");
        }

        if (!response.ok) {
            const error = new Error(
                result.message || "API request failed"
            );

            error.code = result.code;
            error.status = response.status;

            throw error;
        }

        return result;
    }

    async function checkDevice() {
        if (checking || locked) return;

        checking = true;

        try {
            const result = await apiRequest("check_device");

            if (
                result.locked === true ||
                result.code === "DEVICE_LOCKED"
            ) {
                showLockedScreen();
            }
        } catch (error) {
            console.warn(
                "Không thể kiểm tra trạng thái thiết bị:",
                error
            );
        } finally {
            checking = false;
        }
    }

    async function reportAndLock(eventName) {
        if (locked) return;

        // Đánh dấu khóa nội bộ, không hiện màn hình khóa.
        showLockedScreen();

        // Gửi báo cáo lên Worker.
        try {
            await apiRequest("lock_device", {
                event: eventName,
                userAgent: navigator.userAgent
            });
        } catch (error) {
            console.error(
                "Không gửi được báo cáo lên Worker:",
                error
            );
        }

        // Chỉ tải lại khi phát hiện phím bất thường.
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    }

    document.addEventListener("keydown", function (e) {
        const key = String(e.key || "").toLowerCase();

        const devtoolsShortcut =
            e.key === "F12" ||
            (
                e.ctrlKey &&
                e.shiftKey &&
                ["i", "j", "c"].includes(key)
            ) ||
            (
                e.ctrlKey &&
                ["u", "s"].includes(key)
            );

        if (!devtoolsShortcut) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const eventName =
            e.ctrlKey && key === "s"
                ? "ctrl_s"
                : "devtools_shortcut:" + key;

        reportAndLock(eventName);
    }, true);

    document.addEventListener("contextmenu", function (e) {
        e.preventDefault();
    }, true);

    document.addEventListener("selectstart", function (e) {
        if (locked) {
            e.preventDefault();
        }
    }, true);

    checkDevice();
})();
