#include <simdjson.h>
#include <cstdint>
#include <cstring>

using namespace simdjson;

extern "C" {

// Full DOM parse of each line (builds simdjson's tape, no JS objects). Returns lines parsed without error.
int validate_lines(const uint8_t* buf, const int32_t* starts, const int32_t* ends, int n) {
    static dom::parser parser;
    int ok = 0;
    for (int i = 0; i < n; i++) {
        auto doc = parser.parse(buf + starts[i], (size_t)(ends[i] - starts[i]), false);
        if (!doc.error()) ok++;
    }
    return ok;
}

static double type_code(std::string_view t) {
    if (t == "user") return 1;
    if (t == "assistant") return 2;
    if (t == "system") return 3;
    return 0;
}

// Per line, 16 doubles: type, isSidechain, isMeta, isCompactSummary, tsOffset, tsLength, modelOffset, modelLength,
// hasUsage, input, output, cacheRead, cacheCreate, contentKind, isCompactBoundary, postTokens. -1 type = parse error.
int pick_lines(const uint8_t* buf, const int32_t* starts, const int32_t* ends, int n, double* out) {
    static ondemand::parser parser;
    int picked = 0;
    for (int i = 0; i < n; i++) {
        double* o = out + i * 16;
        for (int k = 0; k < 16; k++) o[k] = -1;
        size_t len = (size_t)(ends[i] - starts[i]);
        padded_string_view view(reinterpret_cast<const char*>(buf + starts[i]), len, len + SIMDJSON_PADDING);
        ondemand::document doc;
        if (parser.iterate(view).get(doc)) continue;
        ondemand::object obj;
        if (doc.get_object().get(obj)) continue;
        std::string_view type;
        o[0] = obj.find_field_unordered("type").get_string().get(type) ? 0 : type_code(type);
        bool b;
        o[1] = obj.find_field_unordered("isSidechain").get_bool().get(b) ? 0 : (b ? 1 : 0);
        o[2] = obj.find_field_unordered("isMeta").get_bool().get(b) ? 0 : (b ? 1 : 0);
        o[3] = obj.find_field_unordered("isCompactSummary").get_bool().get(b) ? 0 : (b ? 1 : 0);
        ondemand::raw_json_string raw;
        if (!obj.find_field_unordered("timestamp").get_raw_json_string().get(raw)) {
            const char* p = raw.raw();
            const char* end = std::strchr(p, '"');
            o[4] = (double)(p - reinterpret_cast<const char*>(buf));
            o[5] = (double)(end - p);
        }
        std::string_view subtype;
        if (!obj.find_field_unordered("subtype").get_string().get(subtype) && subtype == "compact_boundary") {
            o[14] = 1;
            int64_t post;
            ondemand::object meta;
            if (!obj.find_field_unordered("compactMetadata").get_object().get(meta) &&
                !meta.find_field_unordered("postTokens").get_int64().get(post)) o[15] = (double)post;
        }
        ondemand::object message;
        if (!obj.find_field_unordered("message").get_object().get(message)) {
            if (!message.find_field_unordered("model").get_raw_json_string().get(raw)) {
                const char* p = raw.raw();
                const char* end = std::strchr(p, '"');
                o[6] = (double)(p - reinterpret_cast<const char*>(buf));
                o[7] = (double)(end - p);
            }
            ondemand::object usage;
            if (!message.find_field_unordered("usage").get_object().get(usage)) {
                o[8] = 1;
                int64_t v;
                o[9] = usage.find_field_unordered("input_tokens").get_int64().get(v) ? 0 : (double)v;
                o[10] = usage.find_field_unordered("output_tokens").get_int64().get(v) ? 0 : (double)v;
                o[11] = usage.find_field_unordered("cache_read_input_tokens").get_int64().get(v) ? 0 : (double)v;
                o[12] = usage.find_field_unordered("cache_creation_input_tokens").get_int64().get(v) ? 0 : (double)v;
            }
            ondemand::value content;
            if (!message.find_field_unordered("content").get(content)) {
                ondemand::json_type jt;
                if (!content.type().get(jt)) {
                    if (jt == ondemand::json_type::string) o[13] = 1;
                    else if (jt == ondemand::json_type::array) {
                        o[13] = 3;
                        ondemand::array arr;
                        if (!content.get_array().get(arr)) {
                            for (auto part : arr) {
                                ondemand::object po;
                                std::string_view pt;
                                if (!part.get_object().get(po) && !po.find_field_unordered("type").get_string().get(pt) && pt == "text") { o[13] = 2; break; }
                            }
                        }
                    }
                }
            }
        }
        picked++;
    }
    return picked;
}

}
