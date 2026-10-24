(function () {
    "use strict";

    const CONFIG = {
        WORKER_URL: "https://api-quiz.abcd1601ab.workers.dev",

        CHECK_PATH: "/check",
        QUIZ_PATH: "/quiz",

        WAYGROUND_URL: "https://wayground.com/pro/join?gc=",

        TIMEOUT: 20000,

        DEVICE_ID_KEY: "kho_tai_lieu_device_id_v1",
        DEVICE_TOKEN_KEY: "kho_tai_lieu_device_token_v1"
    };

    const params = new URLSearchParams(
        window.location.search
    );

    const state = {
        code: (params.get("code") || "").trim(),
        loading: false
    };

    const elements = {
        frame: document.getElementById("quizFrame"),
        statusPage: document.getElementById("statusPage")
    };

    /* ================================================
       LẤY THÔNG TIN THIẾT BỊ ĐÃ LƯU
    ================================================= */

    function getCreds() {
        try {
            return {
                deviceId:
                    localStorage.getItem(
                        CONFIG.DEVICE_ID_KEY
                    ) || "",

                deviceToken:
                    localStorage.getItem(
                        CONFIG.DEVICE_TOKEN_KEY
                    ) || ""
            };
        } catch (error) {
            return {
                deviceId: "",
                deviceToken: ""
            };
        }
    }

    /* ================================================
       HIỂN THỊ TRẠNG THÁI
    ================================================= */

    function showStatus(
        type,
        title,
        message,
        symbol
    ) {
        elements.frame.style.display = "none";
        elements.frame.removeAttribute("src");

        elements.statusPage.style.display = "flex";
        elements.statusPage.replaceChildren();

        const box = document.createElement("div");
        box.className = "status-box " + type;

        const icon = document.createElement("div");
        icon.className = "status-icon";

        if (type === "loading") {
            icon.classList.add("loading-spinner");
        } else {
            icon.textContent = symbol || "!";
        }

        const heading = document.createElement("h2");
        heading.textContent = title;

        const paragraph = document.createElement("p");
        paragraph.textContent = message;

        box.appendChild(icon);
        box.appendChild(heading);
        box.appendChild(paragraph);

        elements.statusPage.appendChild(box);
    }

    /* ================================================
       GỌI API WORKER
    ================================================= */

    async function requestJSON(
        path,
        query = {},
        options = {}
    ) {
        const url = new URL(
            path,
            CONFIG.WORKER_URL
        );

        Object.entries(query).forEach(
            function ([key, value]) {
                if (
                    value !== null &&
                    value !== undefined &&
                    value !== ""
                ) {
                    url.searchParams.set(
                        key,
                        String(value)
                    );
                }
            }
        );

        url.searchParams.set(
            "_refresh",
            String(Date.now())
        );

        const headers = {
            "Accept": "application/json"
        };

        if (options.deviceId) {
            headers["X-Device-Id"] =
                options.deviceId;
        }

        if (
            options.sendToken === true &&
            options.deviceToken
        ) {
            headers["X-Device-Token"] =
                options.deviceToken;
        }

        const response = await fetch(
            url.toString(),
            {
                method: "GET",
                headers: headers,
                cache: "no-store",
                signal: options.signal
            }
        );

        const result = await response.json().catch(
            function () {
                throw new Error(
                    "API không trả về JSON hợp lệ."
                );
            }
        );

        const errorCode = String(
            result?.error ||
            result?.code ||
            result?.reason ||
            ""
        ).toUpperCase();

        if (errorCode === "DEVICE_LOCKED") {
            const error = new Error(
                result?.message ||
                "Thiết bị đã bị khóa."
            );

            error.code = "DEVICE_LOCKED";
            throw error;
        }

        if (
            errorCode === "DEVICE_UNREGISTERED" ||
            errorCode === "DEVICE_NOT_FOUND" ||
            errorCode === "NOT_REGISTERED"
        ) {
            const error = new Error(
                result?.message ||
                "Thiết bị chưa được đăng ký."
            );

            error.code = "DEVICE_UNREGISTERED";
            throw error;
        }

        if (
            errorCode === "DEVICE_EXPIRED" ||
            errorCode === "DEVICE_RENEW_REQUIRED"
        ) {
            const error = new Error(
                result?.message ||
                "Thiết bị đã hết hạn hoặc cần gia hạn."
            );

            error.code = "DEVICE_EXPIRED";
            throw error;
        }

        if (
            !response.ok ||
            result?.success === false
        ) {
            const error = new Error(
                result?.message ||
                result?.error ||
                "Yêu cầu API thất bại."
            );

            error.code = errorCode || "API_ERROR";
            error.status = response.status;

            throw error;
        }

        return result;
    }

    /* ================================================
       BƯỚC 1: KIỂM TRA THIẾT BỊ

       - Chỉ gửi deviceId.
       - Không gửi deviceToken.
       - Không đăng ký thiết bị.
       - Không gia hạn thiết bị.
       - Nếu thất bại, dừng và không gọi /quiz.
    ================================================= */

    async function checkDevice(
        deviceId,
        signal
    ) {
        const result = await requestJSON(
            CONFIG.CHECK_PATH,
            {
                deviceId: deviceId
            },
            {
                signal: signal
            }
        );

        const status = String(
            result?.status ||
            result?.deviceStatus ||
            result?.data?.status ||
            ""
        ).toLowerCase();

        const errorCode = String(
            result?.error ||
            result?.code ||
            result?.data?.error ||
            result?.data?.code ||
            ""
        ).toUpperCase();

        if (
            errorCode === "DEVICE_LOCKED" ||
            result?.locked === true ||
            result?.data?.locked === true ||
            status === "locked"
        ) {
            const error = new Error(
                result?.message ||
                result?.data?.message ||
                "Thiết bị đã bị khóa."
            );

            error.code = "DEVICE_LOCKED";
            throw error;
        }

        if (
            errorCode === "DEVICE_UNREGISTERED" ||
            errorCode === "DEVICE_NOT_FOUND" ||
            errorCode === "NOT_REGISTERED" ||
            result?.registered === false ||
            result?.exists === false ||
            result?.found === false ||
            result?.data?.registered === false ||
            result?.data?.exists === false ||
            result?.data?.found === false ||
            status === "unregistered" ||
            status === "not_found"
        ) {
            const error = new Error(
                result?.message ||
                result?.data?.message ||
                "Thiết bị chưa được đăng ký."
            );

            error.code = "DEVICE_UNREGISTERED";
            throw error;
        }

        if (
            errorCode === "DEVICE_EXPIRED" ||
            errorCode === "DEVICE_RENEW_REQUIRED" ||
            result?.expired === true ||
            result?.data?.expired === true ||
            status === "expired" ||
            status === "renew_required"
        ) {
            const error = new Error(
                result?.message ||
                result?.data?.message ||
                "Thiết bị đã hết hạn hoặc cần gia hạn."
            );

            error.code = "DEVICE_EXPIRED";
            throw error;
        }

        /*
         * Chỉ chấp nhận phản hồi xác nhận thành công.
         * Không gọi /quiz nếu /check không xác nhận thành công.
         */
        if (result?.success !== true) {
            const error = new Error(
                result?.message ||
                "Không xác minh được thiết bị. Không thể tiếp tục."
            );

            error.code = "DEVICE_CHECK_FAILED";
            throw error;
        }

        return result;
    }

    /* ================================================
       BƯỚC 2: ĐỌC THỜI GIAN QUIZ
    ================================================= */

    function parseTime(value) {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return null;
        }

        if (
            typeof value === "number" &&
            Number.isFinite(value)
        ) {
            return value < 1000000000000
                ? value * 1000
                : value;
        }

        const text = String(value).trim();

        if (/^\d{10,13}$/.test(text)) {
            const number = Number(text);

            return number < 1000000000000
                ? number * 1000
                : number;
        }

        const parsed = Date.parse(text);

        return Number.isFinite(parsed)
            ? parsed
            : null;
    }

    function getQuizStatus(quiz) {
        const startTime = parseTime(
            quiz.startTime ??
            quiz.start_time ??
            quiz.start ??
            ""
        );

        const endTime = parseTime(
            quiz.endTime ??
            quiz.end_time ??
            quiz.end ??
            ""
        );

        const now = Date.now();

        if (
            startTime === null ||
            endTime === null ||
            startTime >= endTime
        ) {
            return {
                type: "error",
                title: "Không xác định được thời gian",
                message:
                    "Thời gian bắt đầu hoặc kết thúc của Quiz không hợp lệ.",
                canPlay: false
            };
        }

        if (now < startTime) {
            return {
                type: "upcoming",
                title: "Quiz này chưa mở",
                message:
                    "Vui lòng quay lại khi đến giờ bắt đầu.",
                canPlay: false
            };
        }

        if (now >= endTime) {
            return {
                type: "closed",
                title: "Quiz này đã đóng",
                message:
                    "Phiên Quiz đã hết thời gian tham gia.",
                canPlay: false
            };
        }

        return {
            type: "open",
            title: "Quiz đang mở",
            message: "Đang chuyển đến trang Quiz.",
            canPlay: true
        };
    }

    /* ================================================
       BƯỚC 3: MỞ QUIZ
    ================================================= */

    function enterQuiz(code) {
        const quizCode = String(
            code || ""
        ).trim();

        if (!/^\d+$/.test(quizCode)) {
            showStatus(
                "error",
                "Mã Quiz không hợp lệ",
                "Không thể mở phiên Quiz với mã này.",
                "!"
            );

            return;
        }

        elements.statusPage.style.display = "none";
        elements.frame.style.display = "block";

        elements.frame.src =
            CONFIG.WAYGROUND_URL +
            encodeURIComponent(quizCode);
    }

    /* ================================================
       LUỒNG CHÍNH

       1. Lấy deviceId.
       2. Gọi /check.
       3. Chỉ khi /check thành công mới gọi /quiz.
       4. Đọc data.data hoặc data.quiz.
       5. Kiểm tra thời gian rồi mở Quiz.

       Không gọi /register hoặc /renew ở trang này.
    ================================================= */

    async function checkQuiz() {
        if (state.loading) {
            return;
        }

        if (
            !state.code ||
            !/^\d+$/.test(state.code)
        ) {
            showStatus(
                "error",
                "Mã Quiz không hợp lệ",
                "Vui lòng kiểm tra lại đường dẫn tham gia Quiz.",
                "!"
            );

            return;
        }

        state.loading = true;

        showStatus(
            "loading",
            "Đang kiểm tra thiết bị",
            "Vui lòng chờ trong giây lát.",
            ""
        );

        let controller = null;
        let timeoutId = null;

        try {
            controller = new AbortController();

            timeoutId = setTimeout(
                function () {
                    controller.abort();
                },
                CONFIG.TIMEOUT
            );

            const creds = getCreds();

            if (!creds.deviceId) {
                const error = new Error(
                    "Không tìm thấy deviceId đã lưu. Vui lòng đăng ký thiết bị tại Kho tài liệu trước."
                );

                error.code = "DEVICE_UNREGISTERED";
                throw error;
            }

            /*
             * BẮT BUỘC: CHECK THIẾT BỊ TRƯỚC.
             * Nếu dòng này lỗi, chương trình nhảy thẳng
             * vào catch và không thực hiện lệnh gọi /quiz.
             */
            await checkDevice(
                creds.deviceId,
                controller.signal
            );

            showStatus(
                "loading",
                "Thiết bị hợp lệ",
                "Đang kiểm tra thông tin Quiz.",
                ""
            );

            /*
             * Chỉ đến đây sau khi /check thành công.
             * Token cũ chỉ được gửi ở bước /quiz nếu có.
             * Không tạo token mới và không gia hạn token.
             */
            const data = await requestJSON(
                CONFIG.QUIZ_PATH,
                {
                    code: state.code
                },
                {
                    deviceId: creds.deviceId,
                    deviceToken: creds.deviceToken,
                    sendToken: true,
                    signal: controller.signal
                }
            );

            if (data?.success !== true) {
                showStatus(
                    "error",
                    "Không tìm thấy mã Quiz",
                    data?.message ||
                        "Mã phiên này không tồn tại.",
                    "!"
                );

                return;
            }

            /*
             * Hỗ trợ cả hai cấu trúc phản hồi:
             * { success: true, data: {...} }
             * { success: true, quiz: {...} }
             */
            const quiz =
                data?.data?.quiz ||
                data?.data ||
                data?.quiz;

            if (
                !quiz ||
                typeof quiz !== "object"
            ) {
                showStatus(
                    "error",
                    "Dữ liệu Quiz không hợp lệ",
                    "Worker không trả về thông tin Quiz đúng định dạng.",
                    "!"
                );

                return;
            }

            const returnedCode = String(
                quiz.code ?? ""
            ).trim();

            if (returnedCode !== state.code) {
                showStatus(
                    "error",
                    "Mã Quiz không khớp",
                    "Dữ liệu API không khớp với mã phiên trên đường dẫn.",
                    "!"
                );

                return;
            }

            const quizStatus = getQuizStatus(quiz);

            if (!quizStatus.canPlay) {
                const symbol =
                    quizStatus.type === "upcoming"
                        ? "◷"
                        : quizStatus.type === "closed"
                            ? "×"
                            : "!";

                showStatus(
                    quizStatus.type,
                    quizStatus.title,
                    quizStatus.message,
                    symbol
                );

                return;
            }

            enterQuiz(quiz.code);

        } catch (error) {
            if (error?.name === "AbortError") {
                showStatus(
                    "error",
                    "API phản hồi quá lâu",
                    "Đã quá thời gian chờ 20 giây. Vui lòng tải lại trang.",
                    "!"
                );

                return;
            }

            if (error?.code === "DEVICE_LOCKED") {
                showStatus(
                    "locked",
                    "Thiết bị đã bị khóa",
                    error.message ||
                        "Thiết bị này không được phép truy cập.",
                    "!"
                );

                return;
            }

            if (
                error?.code === "DEVICE_UNREGISTERED"
            ) {
                showStatus(
                    "error",
                    "Thiết bị chưa được đăng ký",
                    error.message ||
                        "Vui lòng đăng ký thiết bị tại Kho tài liệu trước khi tham gia Quiz.",
                    "!"
                );

                return;
            }

            if (
                error?.code === "DEVICE_EXPIRED"
            ) {
                showStatus(
                    "error",
                    "Thiết bị cần được gia hạn",
                    error.message ||
                        "Trang Quiz không có quyền gia hạn thiết bị. Vui lòng thực hiện tại Kho tài liệu.",
                    "!"
                );

                return;
            }

            if (
                error?.code === "DEVICE_CHECK_FAILED"
            ) {
                showStatus(
                    "error",
                    "Không xác minh được thiết bị",
                    error.message ||
                        "Không thể xác nhận quyền truy cập. Quiz chưa được gọi.",
                    "!"
                );

                return;
            }

            showStatus(
                "error",
                "Không thể kiểm tra Quiz",
                error?.message ||
                    "Không tải được dữ liệu từ API. Vui lòng thử lại sau.",
                "!"
            );

        } finally {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }

            state.loading = false;
        }
    }

    /* ================================================
       KHỞI CHẠY
    ================================================= */

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            checkQuiz,
            { once: true }
        );
    } else {
        checkQuiz();
    }

})();
