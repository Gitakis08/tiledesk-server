var passportJWT = require("passport-jwt");
var JwtStrategy = passportJWT.Strategy;
var ExtractJwt = passportJWT.ExtractJwt;

var passportHttp = require("passport-http");
var BasicStrategy = passportHttp.BasicStrategy;
var GoogleStrategy = require('passport-google-oidc');

var winston = require('../config/winston');
// var AnonymousStrategy = require('passport-anonymous').Strategy;

// load up the user model
var User = require('../models/user');
var config = require('../config/database'); // get db config file
var Faq_kb = require("../models/faq_kb");
var Project = require('../models/project');
var Subscription = require('../models/subscription');

var Auth = require('../models/auth');
var userService = require('../services/userService');

var UserUtil = require('../utils/userUtil');
var jwt = require('jsonwebtoken');
const url = require('url');
var cacheUtil = require('../utils/cacheUtil');
var cacheEnabler = require("../services/cacheEnabler");

var uniqid = require('uniqid');


const MaskData = require("maskdata");

const maskOptions = {
    // Character to mask the data. default value is '*'
    maskWith: "*",
    // If the starting 'n' digits needs to be unmasked
    // Default value is 4
    unmaskedStartDigits: 3, //Should be positive Integer
    //If the ending 'n' digits needs to be unmasked
    // Default value is 1
    unmaskedEndDigits: 3 // Should be positive Integer
};

var alg = process.env.GLOBAL_SECRET_ALGORITHM;
winston.info('Authentication Global Algorithm : ' + alg);

// TODO STAMPA ANCHE PUBLIC

var configSecret = process.env.GLOBAL_SECRET || config.secret;

var pKey = process.env.GLOBAL_SECRET_OR_PUB_KEY;
// console.log("pKey",pKey);

if (pKey) {
    configSecret = pKey.replace(/\\n/g, '\n');
}
// console.log("configSecret",configSecret);
// if (process.env.GLOBAL_SECRET_OR_PUB_KEY) {
//   console.log("GLOBAL_SECRET_OR_PUB_KEY defined");

// }else {
//   console.log("GLOBAL_SECRET_OR_PUB_KEY undefined");
// }

var maskedconfigSecret = MaskData.maskPhone(configSecret, maskOptions);
winston.info('Authentication Global Secret : ' + maskedconfigSecret);

var enableGoogleSignin = false;
if (process.env.GOOGLE_SIGNIN_ENABLED == "true" || process.env.GOOGLE_SIGNIN_ENABLED == true) {
    enableGoogleSignin = true;
}
winston.info('Authentication Google Signin enabled : ' + enableGoogleSignin);


var enableOauth2Signin = false;
if (process.env.OAUTH2_SIGNIN_ENABLED == "true" || process.env.OAUTH2_SIGNIN_ENABLED == true) {
    enableOauth2Signin = true;
}
winston.info('Authentication Oauth2 Signin enabled : ' + enableOauth2Signin);

/**
 * OAuth2 / OIDC scope list: space-separated in OAUTH2_SCOPE, default Entra-friendly scopes.
 */
function parseOauth2Scope() {
    var s = process.env.OAUTH2_SCOPE;
    if (!s || typeof s !== 'string' || !String(s).trim()) {
        return ['openid', 'profile', 'email'];
    }
    return String(s).trim().split(/\s+/).filter(Boolean);
}

/**
 * Comma-separated Entra directory (tenant) IDs in ALLOWED_ENTRA_TENANTS.
 * Returns null if unset or empty after trim (allow all tenants).
 */
function parseAllowedEntraTenants() {
    var raw = process.env.ALLOWED_ENTRA_TENANTS;
    if (raw == null || raw === '') {
        return null;
    }
    if (typeof raw !== 'string' || !String(raw).trim()) {
        return null;
    }
    var parts = String(raw).split(',').map(function (s) {
        return s.trim().toLowerCase();
    }).filter(Boolean);
    if (parts.length === 0) {
        return null;
    }
    return new Set(parts);
}

function oauth2NormalizeEmailLike(v) {
    if (v === undefined || v === null) {
        return '';
    }
    return String(v).trim().toLowerCase();
}

/** Display name: `name`, else given_name + family_name, else preferred_username (UserInfo / OIDC). */
function oauth2DeriveDisplayName(json) {
    if (!json || typeof json !== 'object') {
        return '';
    }
    var n = json.name != null ? String(json.name).trim() : '';
    if (n) {
        return n;
    }
    var g = json.given_name != null ? String(json.given_name).trim() : '';
    var f = json.family_name != null ? String(json.family_name).trim() : '';
    if (g || f) {
        return [g, f].filter(Boolean).join(' ').trim();
    }
    var u = json.preferred_username != null ? String(json.preferred_username).trim() : '';
    return u;
}

/** Build passport `profile` from UserInfo HTTP body (primary source for Entra / OIDC). */
function oauth2ProfileFromUserInfoBody(body) {
    var json = JSON.parse(body);
    var emailRaw = '';
    if (json.email != null && String(json.email).trim()) {
        emailRaw = String(json.email).trim();
    } else if (json.preferred_username != null && String(json.preferred_username).trim()) {
        emailRaw = String(json.preferred_username).trim();
    }
    return {
        keycloakId: json.sub,
        fullName: oauth2DeriveDisplayName(json),
        firstName: json.given_name != null ? String(json.given_name).trim() : '',
        lastName: json.family_name != null ? String(json.family_name).trim() : '',
        username: json.preferred_username != null ? String(json.preferred_username).trim() : '',
        email: oauth2NormalizeEmailLike(emailRaw),
    };
}

var oauth2UserProfileInstalled = false;

function installOauth2UserProfileOnce(OAuth2Strategy) {
    if (oauth2UserProfileInstalled) {
        return;
    }
    oauth2UserProfileInstalled = true;
    OAuth2Strategy.prototype.userProfile = function (accessToken, done) {
        this._oauth2._useAuthorizationHeaderForGET = true;
        this._oauth2.get(process.env.OAUTH2_USER_INFO_URL, accessToken, function (err, body) {
            if (err) {
                return done(err);
            }
            try {
                var profile = oauth2ProfileFromUserInfoBody(body);
                winston.debug('OAuth2 userProfile', profile);
                done(null, profile);
            } catch (e) {
                done(e);
            }
        });
    };
}

var jwthistory = undefined;
try {
    jwthistory = require('@tiledesk-ent/tiledesk-server-jwthistory');
} catch (err) {
    winston.debug("jwthistory not present");
}

module.exports = function (passport) {

    // passport.serializeUser(function(user, done) {
    //     console.log("serializeUser");

    //     done(null, user);
    //   });

    //   passport.deserializeUser(function(user, done) {
    //     done(null, user);
    //   });

    var opts = {
        // jwtFromRequest: ExtractJwt.fromAuthHeader(),
        jwtFromRequest: ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderWithScheme("jwt"), ExtractJwt.fromUrlQueryParameter('secret_token')]),
        //this will help you to pass request body to passport
        passReqToCallback: true, //https://stackoverflow.com/questions/55163015/how-to-bind-or-pass-req-parameter-to-passport-js-jwt-strategy
        // secretOrKey: configSecret,
        secretOrKeyProvider: function (request, rawJwtToken, done) {
            // winston.info("secretOrKeyProvider ", request );

            // if (request.project) {
            //   winston.info("secretOrKeyProvider.request.project.jwtSecret: "+request.project.jwtSecret );
            // }

            // winston.info("secretOrKeyProvider: "+request.project.name );
            // winston.info("secretOrKeyProvider: "+rawJwtToken );

            var decoded = request.preDecodedJwt
            winston.debug("decoded: ", decoded);
            if (!decoded) { //fallback
                winston.debug("load decoded after: ");
                decoded = jwt.decode(rawJwtToken);
            }

            winston.debug("decoded after: ", decoded);

            // qui arriva questo 
            // decoded:  {"_id":"5ce3ee855c520200176c189e","updatedAt":"2019-05-31T09:50:22.949Z","createdAt":"2019-05-21T12:26:45.192Z","name":"botext","url":"https://tiledesk-v2-simple--andrealeo83.repl.co","id_project":"5ce3d1ceb25ad30017274bc5","trashed":false,"createdBy":"5ce3d1c7b25ad30017274bc2","__v":0,"external":true,"iat":1559297130,"aud":"https://tiledesk.com","iss":"https://tiledesk.com","sub":"5ce3ee855c520200176c189e@tiledesk.com/bot"}


            if (decoded && decoded.aud) {

                winston.debug("decoded.aud: " + decoded.aud);


                const audUrl = new URL(decoded.aud);
                winston.debug("audUrl: " + audUrl);
                const path = audUrl.pathname;
                winston.debug("audUrl path: " + path);

                const AudienceType = path.split("/")[1];
                winston.debug("audUrl AudienceType: " + AudienceType);

                const AudienceId = path.split("/")[2];
                winston.debug("audUrl AudienceId: " + AudienceId);

                if (AudienceType == "bots") {

                    if (!AudienceId) {
                        winston.error("AudienceId for bots is required: ", decoded);
                        return done(null, null);
                    }

                    winston.debug("bot id AudienceId: " + AudienceId);
                    let qbot = Faq_kb.findById(AudienceId).select('+secret');

                    if (cacheEnabler.faq_kb) {
                        let id_project = decoded.id_project;
                        winston.debug("decoded.id_project:" + decoded.id_project);
                        qbot.cache(cacheUtil.defaultTTL, id_project + ":faq_kbs:id:" + AudienceId + ":secret")
                        winston.debug('faq_kb AudienceId cache enabled');
                    }


                    qbot.exec(function (err, faq_kb) { //TODO add cache_bot_here
                        if (err) {
                            winston.error("auth Faq_kb err: ", {error: err, decoded: decoded});
                            return done(null, null);
                        }
                        if (!faq_kb) {
                            winston.warn("faq_kb not found with id: " + AudienceId, decoded);
                            return done(null, null);
                        }

                        winston.debug("faq_kb: ", faq_kb);
                        // winston.debug("faq_kb.secret: "+ faq_kb.secret );
                        done(null, faq_kb.secret);
                    });
                } else if (AudienceType == "projects") {
                    if (!AudienceId) {
                        winston.error("AudienceId for projects is required: ", decoded);
                        return done(null, null);
                    }

                    winston.debug("project id: " + AudienceId);
                    Project.findOne({_id: AudienceId, status: 100}).select('+jwtSecret')
                        //@DISABLED_CACHE .cache(cacheUtil.queryTTL, "projects:query:id:status:100:"+AudienceId+":select:+jwtSecret") //project_cache
                        .exec(function (err, project) {
                            if (err) {
                                winston.error("auth Project err: ", {error: err, decoded: decoded});
                                return done(null, null);
                            }
                            if (!project) {
                                winston.warn("Project not found with id: " + AudienceId, decoded);
                                return done(null, null);
                            }
                            winston.debug("project: ", project);
                            winston.debug("project.jwtSecret: " + project.jwtSecret);
                            done(null, project.jwtSecret);
                        });

                } else if (AudienceType == "subscriptions") {

                    if (!AudienceId) {
                        winston.error("AudienceId for subscriptions is required: ", decoded);
                        return done(null, null);
                    }

                    winston.debug("Subscription id: " + AudienceId);
                    Subscription.findById(AudienceId).select('+secret').exec(function (err, subscription) {
                        if (err) {
                            winston.error("auth Subscription err: ", {error: err, decoded: decoded});
                            return done(null, null);
                        }
                        if (!subscription) {
                            winston.warn("subscription not found with id: " + AudienceId, decoded);
                            return done(null, null);
                        }
                        winston.debug("subscription: ", subscription);
                        winston.debug("subscription.secret: " + subscription.secret);
                        done(null, subscription.secret);
                    });
                } else if (decoded.aud == "https://tiledesk.com") {
                    winston.debug("configSecret: " + maskedconfigSecret);
                    done(null, configSecret); //pub_jwt pp_jwt 
                } else {
                    winston.debug("configSecret: " + maskedconfigSecret);
                    done(null, configSecret); //pub_jwt pp_jwt
                }
            } else {
                winston.debug("configSecret: " + maskedconfigSecret);
                done(null, configSecret); //pub_jwt pp_jwt
            }
        }
    }


    winston.debug("passport opts: ", opts);

    passport.use(new JwtStrategy(opts, async (req, jwt_payload, done) => {
        // passport.use(new JwtStrategy(opts, function(req, jwt_payload, done) {
        winston.debug("jwt_payload", jwt_payload);
        // console.log("req",req);


        // console.log("jwt_payload._doc._id",jwt_payload._doc._id);


        if (jwt_payload._id == undefined && (jwt_payload._doc == undefined || (jwt_payload._doc && jwt_payload._doc._id == undefined))) {
            var err = "jwt_payload._id or jwt_payload._doc._id can t be undefined";
            winston.error(err);
            return done(null, false);
        }
        //JWT OLD format
        const identifier = jwt_payload._id || jwt_payload._doc._id;

        // const subject = jwt_payload.sub || jwt_payload._id || jwt_payload._doc._id;
        winston.debug("passport identifier: " + identifier);

        const subject = jwt_payload.sub;
        winston.debug("passport subject: " + subject);

        winston.debug("passport identifier: " + identifier + " subject " + subject);

        var fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
        winston.debug("fullUrl:" + fullUrl);

        winston.debug("req.disablePassportEntityCheck:" + req.disablePassportEntityCheck);

        if (req && req.disablePassportEntityCheck) { //req can be null
            // jwt_payload.id = jwt_payload._id; //often req.user.id is used inside code. req.user.id  is a mongoose getter of _id
            // is better to rename req.user.id to req.user._id in all files
            winston.debug("req.disablePassportEntityCheck enabled");
            return done(null, jwt_payload);
        }

        //TODO check into DB if JWT is revoked 
        if (jwthistory) {
            var jwtRevoked = await jwthistory.isJWTRevoked(jwt_payload.jti);
            winston.debug("passport jwt jwtRevoked: " + jwtRevoked);
            if (jwtRevoked) {
                winston.warn("passport jwt is revoked with jti: " + jwt_payload.jti);
                return done(null, false);
            }
        }

        if (subject == "bot") {
            winston.debug("Passport JWT bot");

            let qbot = Faq_kb.findOne({_id: identifier}); //TODO add cache_bot_here

            if (cacheEnabler.faq_kb) {
                let id_project = jwt_payload.id_project;
                winston.debug("jwt_payload.id_project:" + jwt_payload.id_project);
                qbot.cache(cacheUtil.defaultTTL, id_project + ":faq_kbs:id:" + identifier)
                winston.debug('faq_kb cache enabled');
            }

            qbot.exec(function (err, faq_kb) {

                if (err) {
                    winston.error("Passport JWT bot err", err);
                    return done(err, false);
                }
                if (faq_kb) {
                    winston.debug("Passport JWT bot user", faq_kb);
                    return done(null, faq_kb);
                } else {
                    winston.warn("Passport JWT bot not user");
                    return done(null, false);
                }
            });
            // } else if (subject=="projects") {      

        } else if (subject == "subscription") {

            Subscription.findOne({_id: identifier}, function (err, subscription) {
                if (err) {
                    winston.error("Passport JWT subscription err", err);
                    return done(err, false);
                }
                if (subscription) {
                    winston.debug("Passport JWT subscription user", subscription);
                    return done(null, subscription);
                } else {
                    winston.warn("Passport JWT subscription not user", subscription);
                    return done(null, false);
                }
            });

        } else if (subject == "userexternal") {


            if (jwt_payload) {

                // const audUrl  = new URL(jwt_payload.aud);
                // winston.info("audUrl: "+ audUrl );

                // const path = audUrl.pathname;
                // winston.info("audUrl path: " + path );

                // const AudienceType = path.split("/")[1];
                // winston.info("audUrl AudienceType: " + AudienceType );

                // const AudienceId = path.split("/")[2];
                // winston.info("audUrl AudienceId: " + AudienceId );

                // jwt_payload._id = AudienceId + "-" + jwt_payload._id;


                winston.debug("Passport JWT userexternal", jwt_payload);
                var userM = UserUtil.decorateUser(jwt_payload);
                winston.debug("Passport JWT userexternal userM", userM);

                return done(null, userM);
            } else {
                var err = {msg: "No jwt_payload passed. Its required"};
                winston.error("Passport JWT userexternal err", err);
                return done(err, false);
            }

        } else if (subject == "guest") {


            if (jwt_payload) {
                winston.debug("Passport JWT guest", jwt_payload);
                var userM = UserUtil.decorateUser(jwt_payload);
                winston.debug("Passport JWT guest userM", userM);
                return done(null, userM);
            } else {
                var err = {msg: "No jwt_payload passed. Its required"};
                winston.error("Passport JWT guest err", err);
                return done(err, false);
            }

        } else {
            winston.debug("Passport JWT generic user");
            let quser = User.findOne({_id: identifier, status: 100})   //TODO user_cache_here
            //@DISABLED_CACHE .cache(cacheUtil.defaultTTL, "users:id:"+identifier)

            if (cacheEnabler.user) {
                quser.cache(cacheUtil.defaultTTL, "users:id:" + identifier)
                winston.debug('user cache enabled');
            }

            quser.exec(function (err, user) {
                if (err) {
                    winston.error("Passport JWT generic err ", err);
                    return done(err, false);
                }
                if (user) {
                    winston.debug("Passport JWT generic user ", user);
                    return done(null, user);
                } else {
                    winston.debug("Passport JWT generic not user");
                    return done(null, false);
                }
            });

        }


    }));


    passport.use(new BasicStrategy(function (userid, password, done) {

        winston.debug("BasicStrategy: " + userid);


        var email = userid.toLowerCase();
        winston.debug("email lowercase: " + email);

        User.findOne({
            email: email,
            status: 100
        }, 'email firstname lastname password emailverified id') //TODO user_cache_here. NOT used frequently. ma attento select. ATTENTO QUI NN USEREI LA SELECT altrimenti con JWT ho tuttto USER mentre con basich auth solo aluni campi
            //@DISABLED_CACHE .cache(cacheUtil.defaultTTL, "users:email:"+email)
            .exec(function (err, user) {

                if (err) {
                    // console.log("BasicStrategy err.stop");
                    return done(err);
                }
                if (!user) {
                    return done(null, false);
                }

                user.comparePassword(password, function (err, isMatch) {
                    if (isMatch && !err) {

                        // if user is found and password is right create a token
                        // console.log("BasicStrategy ok");
                        return done(null, user);

                    } else {
                        return done(err);
                    }
                });


                // if (user) { return done(null, user); }
                // if (!user) { return done(null, false); }
                // if (!user.verifyPassword(password)) { return done(null, false); }
            });
    }));


    if (enableGoogleSignin == true) {
        let googleClientId = process.env.GOOGLE_CLIENT_ID;
        let googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
        let googleCallbackURL = process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback";

        winston.info("Enabling Google Signin strategy with ClientId: " + googleClientId + " callbackURL: " + googleCallbackURL + " clientSecret: " + googleClientSecret);

        passport.use(new GoogleStrategy({
                clientID: googleClientId,
                clientSecret: googleClientSecret,
                callbackURL: googleCallbackURL,
            },
            async function (issuer, profile, cb) {
                try {
                    winston.debug("issuer: " + issuer);
                    winston.debug("profile", profile);

                    const rawEmail = profile?.emails?.[0]?.value;
                    if (!rawEmail) {
                        winston.warn("Google profile has no email", {issuer: issuer, profileId: profile?.id});
                        return cb(null, false, {message: "Missing email from Google profile."});
                    }

                    const email = rawEmail.toLowerCase().trim();
                    winston.debug("email: " + email);

                    const query = {providerId: issuer, subject: profile.id};
                    winston.debug("query", query);

                    const cred = await Auth.findOne(query).exec();
                    winston.debug("cred", cred);

                    if (cred) {
                        // Already linked: return the corresponding user
                        const user = await User.findOne({email: email, status: 100})
                            .select('email firstname lastname password emailverified id')
                            .exec();

                        if (!user) {
                            winston.warn("Auth link exists but user not found/active", {email: email, query: query});
                            return cb(null, false, {message: "User not found."});
                        }

                        return cb(null, user);
                    }

                    // Not linked yet: try to reuse existing account by email
                    let user = await User.findOne({email: email, status: 100})
                        .select('email firstname lastname password emailverified id')
                        .exec();

                    if (!user) {
                        // No existing user -> create one
                        const password = uniqid();
                        try {
                            user = await userService.signup(email, password, profile.displayName, "", true);
                        } catch (err) {
                            // Race/duplicate: fall back to existing user
                            if (err && (err.code === 11000 || err.code === "E11000")) {
                                user = await User.findOne({email: email, status: 100}).exec();
                            } else {
                                winston.error("Error signup google", err);
                                return cb(err);
                            }
                        }
                    }

                    if (!user) {
                        return cb(null, false, {message: "User not found."});
                    }

                    // Ensure Auth link is created (idempotent)
                    await Auth.findOneAndUpdate(
                        query,
                        {$setOnInsert: {providerId: issuer, email: email, subject: profile.id}},
                        {upsert: true, new: true}
                    ).exec();

                    return cb(null, user);
                } catch (err) {
                    winston.error("Google strategy verify error", err);
                    return cb(err);
                }
            }
        ));

    }


    if (enableOauth2Signin == true) {

        var OAuth2Strategy = require('passport-oauth2');
        installOauth2UserProfileOnce(OAuth2Strategy);

        passport.use(new OAuth2Strategy({
                authorizationURL: process.env.OAUTH2_AUTH_URL,
                tokenURL: process.env.OAUTH2_TOKEN_URL,
                clientID: process.env.OAUTH2_CLIENT_ID,
                clientSecret: process.env.OAUTH2_CLIENT_SECRET,
                callbackURL: process.env.OAUTH2_CALLBACK_URL || "http://localhost:3000/auth/oauth2/callback",
                scope: parseOauth2Scope(),
            },
            function (accessToken, refreshToken, params, profile, cb) {
                var idToken = (params && params.id_token) ? jwt.decode(params.id_token) : null;
                var accessJwt = jwt.decode(accessToken);
                var issuer = (idToken && idToken.iss) || (accessJwt && accessJwt.iss);
                var subject = (profile && profile.keycloakId) || (idToken && idToken.sub) || (accessJwt && accessJwt.sub);
                var email = oauth2NormalizeEmailLike(profile && profile.email);
                if (!email && idToken) {
                    email = oauth2NormalizeEmailLike(idToken.email || idToken.preferred_username || idToken.upn);
                }

                var tenantIdFromToken;
                if (idToken && idToken.tid != null && String(idToken.tid).trim() !== '') {
                    tenantIdFromToken = String(idToken.tid).trim();
                }

                if (!issuer) {
                    winston.warn('OAuth2 sign-in: cannot determine issuer (id_token or access_token JWT iss missing).');
                    return cb(null, false);
                }
                if (!subject) {
                    winston.warn('OAuth2 sign-in: cannot determine subject (UserInfo sub, id_token.sub, or access_token sub missing).');
                    return cb(null, false);
                }
                if (!email) {
                    winston.warn('OAuth2 sign-in: no email, preferred_username, or upn in UserInfo or ID token.');
                    return cb(null, false);
                }

                var allowedEntraTenants = parseAllowedEntraTenants();
                if (allowedEntraTenants) {
                    var tidNorm = tenantIdFromToken ? String(tenantIdFromToken).trim().toLowerCase() : '';
                    if (!tidNorm || !allowedEntraTenants.has(tidNorm)) {
                        winston.warn('OAuth2 sign-in: tenant not allowed', { tid: tenantIdFromToken });
                        return cb(null, false);
                    }
                }

                var firstname = profile.firstName || profile.fullName || profile.username || 'User';
                var lastname = profile.lastName || '';
                var authQuery = {providerId: issuer, subject: subject};

                var oauth2AuthFields = {providerId: issuer, email: email, subject: subject};
                if (tenantIdFromToken) {
                    oauth2AuthFields.tenantId = tenantIdFromToken;
                }

                winston.debug('OAuth2 verify', {issuer: issuer, subject: subject, email: email, tid: tenantIdFromToken});

                Auth.findOne(authQuery, function (err, cred) {
                    if (err) {
                        return cb(err);
                    }
                    if (!cred) {
                        User.findOne({
                            email: email, status: 100
                        }, 'email firstname lastname emailverified id', function (findExistingErr, existingUser) {
                            if (findExistingErr) {
                                return cb(findExistingErr);
                            }
                            if (existingUser) {
                                var linkAuthDoc = new Auth(oauth2AuthFields);
                                linkAuthDoc.save(function (linkSaveErr) {
                                    if (linkSaveErr) {
                                        return cb(linkSaveErr);
                                    }
                                    return cb(null, existingUser);
                                });
                            } else {
                                var password = uniqid();
                                userService.signup(email, password, firstname, lastname, true)
                                    .then(function (savedUser) {
                                        var authDoc = new Auth(oauth2AuthFields);
                                        authDoc.save(function (saveErr) {
                                            if (saveErr) {
                                                return cb(saveErr);
                                            }
                                            return cb(null, savedUser);
                                        });
                                    }).catch(function (signupErr) {
                                        winston.error("Error signup oauth ", signupErr);
                                        return cb(signupErr);
                                    });
                            }
                        });
                    } else {
                        User.findOne({
                            email: email, status: 100
                        }, 'email firstname lastname emailverified id', function (findErr, user) {
                            if (findErr) {
                                winston.error("Error getting user", user, findErr);
                                return cb(findErr);
                            }
                            if (!user) {
                                winston.info("User not found", user, findErr);
                                return cb(null, false);
                            }
                            return cb(null, user);
                        });
                    }
                });
            }
        ));
    }


// const KeycloakStrategy = require('@exlinc/keycloak-passport')


// // Register the strategy with passport
// passport.use(
//   "keycloak",
//   new KeycloakStrategy(
//     {
//       host: process.env.KEYCLOAK_HOST,
//       realm: process.env.KEYCLOAK_REALM,
//       clientID: process.env.KEYCLOAK_CLIENT_ID,
//       clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
//       callbackURL: `${process.env.AUTH_KEYCLOAK_CALLBACK}`,
//       authorizationURL : `${process.env.KEYCLOAK_HOST}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/auth`,
//       tokenURL : `${process.env.KEYCLOAK_HOST}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
//       userInfoURL : `${process.env.KEYCLOAK_HOST}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/userinfo`
//       // authorizationURL: '123',
//       // tokenURL : '123',
//       // userInfoURL: '123'
//     },
//     (accessToken, refreshToken, profile, done) => {


//       const token = jwt.decode(accessToken); // user id lives in here
//       console.log("token", token);

//       console.log("profile", profile);

//       console.log("accessToken", accessToken);

//       console.log("refreshToken", refreshToken);

//       var issuer = token.iss;
//       var email = profile.email;

//       var query = {providerId : issuer, subject: profile.keycloakId};
//       winston.info("query", query)

//       Auth.findOne(query, function(err, cred){     
//       winston.info("cred", cred, err);
//         if (err) { return cb(err); }
//         if (!cred) {
//           // The oauth account has not logged in to this app before.  Create a
//           // new user record and link it to the oauth account.
//             var password = uniqid()
//            // signup ( email, password, firstname, lastname, emailverified) {
//             userService.signup(email, password,  profile.displayName, "", true)
//             .then(function (savedUser) {

//             winston.info("savedUser", savedUser)    

//             var auth = new Auth({
//               providerId: issuer,
//               email: email,
//               subject: profile.keycloakId,
//             });
//             auth.save(function (err, authSaved) {    
//               if (err) { return cb(err); }
//               winston.info("authSaved", authSaved);

//               return cb(null, savedUser);
//             });
//           }).catch(function(err) {
//               winston.error("Error signup oauth ", err);
//               return cb(err);        
//           });
//         } else {
//           // The Oauth account has previously logged in to the app.  Get the
//           // user record linked to the Oauth account and log the user in.

//           User.findOne({
//             email: email, status: 100
//           }, 'email firstname lastname emailverified id', function (err, user) {

//             winston.info("user",user, err);
//             winston.info("usertoJSON()",user.toJSON());

//             if (err) { 
//               winston.error("Error getting user",user, err);
//               return cb(err); 
//             }

//             if (!user) { 
//               winston.info("User not found",user, err);
//               return cb(null, false); 
//             }

//             return done(null, user);
//           });
//         }
//       });
//     }
//     ));


    // var OidcStrategy = require('passport-openidconnect').Strategy;


    // https://github.com/jaredhanson/passport-anonymous

    // passport.use(new AnonymousStrategy());


// link utili
// https://codeburst.io/how-to-implement-openid-authentication-with-openid-client-and-passport-in-node-js-43d020121e87?gi=4bb439e255a7
    // https://developer.wordpress.com/docs/oauth2/


    // openidconnect
    // https://docs.simplelogin.io/docs/passport/


    // oauth2
    /**
     * BasicStrategy & ClientPasswordStrategy
     *
     * These strategies are used to authenticate registered OAuth clients. They are
     * employed to protect the `token` endpoint, which consumers use to obtain
     * access tokens. The OAuth 2.0 specification suggests that clients use the
     * HTTP Basic scheme to authenticate. Use of the client password strategy
     * allows clients to send the same credentials in the request body (as opposed
     * to the `Authorization` header). While this approach is not recommended by
     * the specification, in practice it is quite common.
     */

    /*
  const ClientPasswordStrategy = require('passport-oauth2-client-password').Strategy;
  
  function verifyClient(clientId, clientSecret, done) {
    
    db.clients.findByClientId(clientId, (error, client) => {
      if (error) return done(error);
      if (!client) return done(null, false);
      if (client.clientSecret !== clientSecret) return done(null, false);
      return done(null, client);
    });
  }
  
  //passport.use(new BasicStrategy(verifyClient));
  
  passport.use(new ClientPasswordStrategy(verifyClient));
  
  
  */


};
