var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var TenantProjectMapSchema = new Schema({
    tenantId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    id_project: {
        type: Schema.Types.ObjectId,
        ref: 'project',
        required: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('tenant_project_map', TenantProjectMapSchema);
